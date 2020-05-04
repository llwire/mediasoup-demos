"use strict";

// Log whole objects instead of giving up after two levels of nesting
require("util").inspect.defaultOptions.depth = null;

const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const KurentoClient = require("kurento-client");
const Mediasoup = require("mediasoup");
const MediasoupOrtc = require("mediasoup-client/lib/ortc");
const MediasoupRtpUtils = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const MediasoupSdpUtils = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SdpTransform = require("sdp-transform");
const SocketServer = require("socket.io");
const Util = require("util");

const CryptoSuiteKurento = "AES_128_CM_HMAC_SHA1_80";
const CryptoSuiteMediasoup = "AES_CM_128_HMAC_SHA1_80";
const CryptoSuiteSdp = "AES_CM_128_HMAC_SHA1_80";

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    expressApp: null,
    https: null,
    socket: null,
    socketServer: null,
  },

  mediasoup: {
    worker: null,
    router: null,

    // WebRTC connection with the browser
    webrtc: {
      recvTransport: null,
      audioProducer: null,
      videoProducer: null,

      sendTransport: null,
      audioConsumer: null,
      videoConsumer: null,
    },

    // RTP connection with Kurento
    rtp: {
      recvTransport: null,
      recvProducer: null,

      sendTransport: null,
      sendConsumer: null,
    },
  },

  kurento: {
    client: null,
    pipeline: null,
    filter: null,
    candidatesQueue: null,

    rtc: {
      recvEndpoint: null,
      sendEndpoint: null,
    },

    // RTP connection with mediasoup
    rtp: {
      recvEndpoint: null,
      sendEndpoint: null,
    },
  },
};

// ----------------------------------------------------------------------------

// Logging
// =======

// Send all logging to both console and WebSocket
["log", "info", "warn", "error"].forEach(function (name) {
  const method = console[name];
  console[name] = function (...args) {
    method(...args);
    if (global.server.socket) {
      global.server.socket.emit("LOG", Util.format(...args));
    }
  };
});

// ----------------------------------------------------------------------------

// HTTPS server
// ============
{
  const expressApp = Express();
  global.server.expressApp = expressApp;
  expressApp.use("/", Express.static(__dirname));

  const https = Https.createServer(
    {
      cert: Fs.readFileSync(CONFIG.https.cert),
      key: Fs.readFileSync(CONFIG.https.certKey),
    },
    expressApp
  );
  global.server.https = https;

  https.on("listening", () => {
    console.log(
      `Web server is listening on https://localhost:${CONFIG.https.port}`
    );
  });
  https.on("error", (err) => {
    console.error("HTTPS error:", err.message);
  });
  https.on("tlsClientError", (err) => {
    if (err.message.includes("alert number 46")) {
      // Ignore: this is the client browser rejecting our self-signed certificate
    } else {
      console.error("TLS error:", err);
    }
  });
  https.listen(CONFIG.https.port);
}

// ----------------------------------------------------------------------------

// WebSocket server
// ================
{
  const socketServer = SocketServer(global.server.https, {
    path: CONFIG.https.wsPath,
    serveClient: false,
    pingTimeout: CONFIG.https.wsPingTimeout,
    pingInterval: CONFIG.https.wsPingInterval,
    transports: ["websocket"],
  });
  global.server.socketServer = socketServer;

  socketServer.on("connect", (socket) => {
    console.log(
      "WebSocket server connected, port: %s",
      socket.request.connection.remotePort
    );
    global.server.socket = socket;

    // Events sent by the client's "socket.io-promise" have the fixed name
    // "request", and a field "type" that we use as identifier
    socket.on("request", handleRequest);

    // Events sent by the client's "socket.io-client" have a name
    // that we use as identifier
    socket.on("DEBUG", handleDebug);

    startKurento();
  });
}

// ----

async function handleRequest(request, callback) {
  let responseData = null;
  // console.log('Request', request)

  switch (request.type) {
    case "START_PRESENTER":
      responseData = await handleStartPresenter(request);
      break;
    case "START_CAST":
      await handleStartCast(false);
      break;
    case "ICE_CANDIDATE":
      await onIceCandidate(request);
      break;
    default:
      console.warn("Invalid request type:", request.type, request);
      break;
  }

  callback({ type: request.type, data: responseData });
}

// ----------------------------------------------------------------------------

async function handleStartPresenter({ sdpOffer }) {
  return await startKurentoSenderEndpoint(sdpOffer);
}

// ----

async function handleStartCast(enableSrt) {
  await startKurentoRtpProducer(enableSrt);
}

// ----------------------------------------------------------------------------

async function startKurento() {
  const kurentoUrl = `ws://${CONFIG.kurento.ip}:${CONFIG.kurento.port}${CONFIG.kurento.wsPath}`;
  console.log("Connect with Kurento Media Server:", kurentoUrl);

  const kmsClient = global.kurento.client || new KurentoClient(kurentoUrl);
  global.kurento.client = kmsClient;
  console.log("Kurento client connected");

  const kmsPipeline = global.kurento.pipeline || await kmsClient.create("MediaPipeline");
  global.kurento.pipeline = kmsPipeline;
  console.log("Kurento pipeline created", kmsPipeline.id);
}

// ----------------------------------------------------------------------------

async function startKurentoSenderEndpoint(sdpOffer) {
  const socket = global.server.socket;
  const pipeline = global.kurento.pipeline;
  const rtcEndpoint = await pipeline.create('WebRtcEndpoint');
  const rtpEndpoint = await pipeline.create("RtpEndpoint");
  const candidatesQueue = global.kurento.candidatesQueue;

  rtcEndpoint.on('OnIceCandidate', ({ candidate }) => {
    const parsedCandidate = KurentoClient.getComplexType('IceCandidate')(candidate);

    console.log('Sending ICE candidate ...')
    socket.emit('ICE_CANDIDATE', parsedCandidate);
  });

  global.kurento.rtc.sendEndpoint = rtcEndpoint;
  global.kurento.rtp.sendEndpoint = rtpEndpoint;

  if (candidatesQueue) {
    while(candidatesQueue.length) {
      const candidate = candidatesQueue.shift();
      rtcEndpoint.addIceCandidate(candidate);
    }
  }
  console.log('Connecting media elements ...');
  rtcEndpoint.connect(rtpEndpoint);

  const sdpAnswer = await rtcEndpoint.processOffer(sdpOffer);
  const gathered = await rtcEndpoint.gatherCandidates();
  console.log("Answer", sdpAnswer);

  socket.emit("CAST_READY");
  return sdpAnswer;
}

function onIceCandidate({ candidate }) {
  console.log('Handling candidates ...')
  var parsedCandidate = KurentoClient.getComplexType('IceCandidate')(candidate);

  if (!global.kurento.candidatesQueue) {
    global.kurento.candidatesQueue = [];
  }
  global.kurento.candidatesQueue.push(parsedCandidate);
}

// ----------------------------------------------------------------------------

async function startKurentoRtpProducer(enableSrtp) {
  const msRouter = global.mediasoup.router;
  const kmsRtpEndpoint = global.kurento.rtp.sendEndpoint;

  // Kurento RtpEndpoint (send media to mediasoup)
  // ---------------------------------------------

  // When sending to mediasoup, we can choose our own identifiers;
  // we choose the defaults from mediasoup just for convenience
  const sdpPayloadType = 102; // getMsPayloadType("video/H264");
  // const sdpHeaderExtId = getMsHeaderExtId("video", "abs-send-time");

  const sdpListenIp = '127.0.0.1'; //msTransport.tuple.localIp;
  const sdpListenPort = '10002'; //msTransport.tuple.localPort;
  const sdpListenPortRtcp = '10003'; //msTransport.rtcpTuple.localPort;

  let sdpProtocol = "RTP/AVP";

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  // `a=extmap:${sdpHeaderExtId} http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n` +

  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${sdpListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${sdpListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${sdpListenPort} ${sdpProtocol} ${sdpPayloadType}\r\n` +
    "a=recvonly\r\n" +
    "a=direction:active\r\n" + // Comedia enabled
    `a=rtcp:${sdpListenPortRtcp}\r\n` +
    `a=rtpmap:${sdpPayloadType} H264/90000\r\n` +
    `a=rtcp-fb:${sdpPayloadType} goog-remb\r\n` +
    `a=rtcp-fb:${sdpPayloadType} ccm fir\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack pli\r\n` +
    `a=fmtp:${sdpPayloadType} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n` +
    "";

  // Set maximum bitrate higher than default of 500 kbps
  await kmsRtpEndpoint.setMaxVideoSendBandwidth(2000); // Send max 2 mbps

  console.log("SDP Offer from App to Kurento RTP SEND:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsRtpEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP SEND to App:\n%s", kmsSdpAnswer);

}

// ----------------------------------------------------------------------------

async function handleDebug() {
  console.log(
    "[DEBUG] mediasoup RTP SEND transport stats (send to Kurento):\n",
    await global.mediasoup.rtp.sendTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP SEND consumer stats (send to Kurento):\n",
    await global.mediasoup.rtp.sendConsumer.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV transport stats (receive from Kurento):\n",
    await global.mediasoup.rtp.recvTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV producer stats (receive from Kurento):\n",
    await global.mediasoup.rtp.recvProducer.getStats()
  );
}

// ----------------------------------------------------------------------------

// Helper function:
// Get mediasoup router's preferred PayloadType
function getMsPayloadType(mimeType) {
  const router = global.mediasoup.router;
  let pt = 0;

  const codec = router.rtpCapabilities.codecs.find(
    (c) => c.mimeType === mimeType
  );
  if (codec) {
    pt = codec.preferredPayloadType;
  }

  return pt;
}

// ----

// Helper function:
// Get mediasoup router's preferred HeaderExtension ID
function getMsHeaderExtId(kind, name) {
  const router = global.mediasoup.router;
  let id = 0;

  const ext = router.rtpCapabilities.headerExtensions.find(
    (e) => e.kind === kind && e.uri.includes(name)
  );
  if (ext) {
    id = ext.preferredId;
  }

  return id;
}

// ----

// Helper function:
// Get RtcpParameters (https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtcpParameters)
// from an SDP object obtained from `SdpTransform.parse()`.
// We need this because MediasoupRtpUtils has useful functions like
// `getRtpEncodings()`, but it lacks something like `getRtcpParameters()`.
function getRtcpParameters(sdpObject, kind) {
  const mediaObject = (sdpObject.media || []).find((m) => m.type === kind);
  if (!mediaObject) {
    throw new Error(`m=${kind} section not found`);
  }

  // Get CNAME
  const ssrcCname = (mediaObject.ssrcs || []).find(
    (s) => s.attribute && s.attribute === "cname"
  );
  const cname = ssrcCname && ssrcCname.value ? ssrcCname.value : null;

  // Get RTCP Reduced Size ("a=rtcp-rsize")
  const reducedSize = "rtcpRsize" in mediaObject;

  return { cname: cname, reducedSize: reducedSize };
}

// ----------------------------------------------------------------------------
