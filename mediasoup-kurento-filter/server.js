"use strict";

// Log whole objects instead of giving up after two levels of nesting
require("util").inspect.defaultOptions.depth = null;

const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const KurentoClient = require("kurento-client");
const SdpTransform = require("sdp-transform");
const SocketServer = require("socket.io");
const Util = require("util");
const Process = require("child_process");
const Porter = require("./porter")();
const { v4: UUIDv4 } = require('uuid');

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

  gstreamer: {
    process: null,
    sdpFilesrc: `/tmp/stream-${UUIDv4()}.sdp`,
    rtmpTarget: process.env.RTMP_DEST || 'rtmp://localhost/live',
  },

  kurento: {
    client: null,
    pipeline: null,
    capabilities: null,
    candidatesQueue: null,

    rtc: {
      recvEndpoint: null,
      sendEndpoint: null,
    },

    rtp: {
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

    // Clean up on disconnect
    socket.on("disconnect", stopStreaming);

    setupKurento();
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

async function setupKurento() {
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

async function handleStartPresenter({ sdpOffer }) {
  return await startKurentoSenderEndpoint(sdpOffer);
}

// ----

async function handleStartCast(enableSrt) {
  await startKurentoRtpProducer(enableSrt);

  await startGStreamerRtmpStream();
}

// ----------------------------------------------------------------------------

async function stopStreaming() {
  if (global.gstreamer.process) {
    global.gstreamer.process.kill();
    global.gstreamer.process = null;
  }

  if (global.kurento.rtp.sendEndpoint) {
    global.kurento.rtp.sendEndpoint.release();
    global.kurento.rtp.sendEndpoint = null;
    console.log('Release RTP send endpoint ...');
  }

  if (global.kurento.rtc.sendEndpoint) {
    global.kurento.rtc.sendEndpoint.release();
    global.kurento.rtc.sendEndpoint = null;
    console.log('Release RTC send endpoint ...');
  }

  if (global.kurento.rtc.recvEndpoint) {
    global.kurento.rtc.recvEndpoint.release();
    global.kurento.rtc.recvEndpoint = null;
    console.log('Release RTC recv endpoint ...');
  }

  if (global.kurento.pipeline) {
    global.kurento.pipeline.release();
    global.kurento.pipeline = null;
    console.log('Release Kurento pipeline ...');
  }

  if (global.gstreamer.sdpFilesrc) {
    if (Fs.existsSync(global.gstreamer.sdpFilesrc)) {
      Fs.unlinkSync(global.gstreamer.sdpFilesrc)
      console.log('Destroy SDP  pipeline ...');
    }

    global.gstreamer.sdpFilesrc = `/tmp/stream-${UUIDv4()}.sdp`;
    console.log('Set new SDP file source', global.gstreamer.sdpFilesrc);
  }
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
  rtcEndpoint.connect(rtcEndpoint);

  console.log('process sdp Offer', sdpOffer);
  const sdpAnswer = await rtcEndpoint.processOffer(sdpOffer);
  const gathered = await rtcEndpoint.gatherCandidates();

  // Parse and store this Answer as the server's capabilities
  // This will then be used to generate a suitable RTP offer
  // when setting up the GStreamer RTP Endpoint
  console.log("Answer", sdpAnswer);
  global.kurento.capabilities = SdpTransform.parse(sdpAnswer);

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
  const kmsRtpEndpoint = global.kurento.rtp.sendEndpoint;

  // Kurento RtpEndpoint (send media to gstreamer sink)
  // --------------------------------------------------
  const sdpVideoPayloadType = 102;
  const sdpHeaderExtId = 2;

  let sdpProtocol = "RTP/AVP";
  const ports = await Porter.getMediaPorts(4);

  const sdp = {
    listenIp: '127.0.0.1',
    headerExtensionId: 2,
    protocol: 'RTP/AVP',
    audio: {
      listenPort: ports.artp,
      listenPortRtcp: ports.artcp,
      payloadType: 111,
    },
    video: {
      listenPort: ports.vrtp,
      listenPortRtcp: ports.artcp,
      payloadType: 102,
    },
  }

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${sdp.listenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${sdp.listenIp}\r\n` +
    "t=0 0\r\n" +

    // audio
    `m=audio ${sdp.audio.listenPort} ${sdp.protocol} ${sdp.audio.payloadType}\r\n` +
    `a=extmap:${sdp.headerExtensionId} http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n` +
    "a=recvonly\r\n" +
    `a=rtpmap:${sdp.audio.payloadType} opus/48000/2\r\n` +
    `a=rtcp:${sdp.audio.listenPortRtcp}\r\n` +
    `a=fmtp:${sdp.audio.payloadType} minptime=10;useinbandfec=1\r\n` +

    // video
    `m=video ${sdp.video.listenPort} ${sdp.protocol} ${sdp.video.payloadType}\r\n` +
    `a=extmap:${sdp.headerExtensionId} http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n` +
    "a=recvonly\r\n" +
    `a=rtpmap:${sdp.video.payloadType} H264/90000\r\n` +
    `a=rtcp:${sdp.video.listenPortRtcp}\r\n` +
    `a=fmtp:${sdp.video.payloadType} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n` +
    "";

  // Set maximum bitrate higher than default of 500 kbps
  await kmsRtpEndpoint.setMaxVideoSendBandwidth(2000); // Send max 2 mbps

  console.log("SDP Offer from App to Kurento RTP SEND:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsRtpEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP SEND to App:\n%s", kmsSdpAnswer);

  // Write the SDP offer to the gstreamer SDP file src
  Fs.writeFileSync(global.gstreamer.sdpFilesrc, kmsSdpOffer)
}

// ----------------------------------------------------------------------------

function startGStreamerRtmpStream() {
  let streamResolve;
  const streamPromise = new Promise((res, _rej) => {
    streamResolve = res;
  });

  // GStreamer RtmpStream (send media to streaming network)
  // This re-streams the RTP media to a specified RTMP target
  // GStreamer transcodes the audio stream in SDP from OPUS to AAC
  // The H264 video stream just passes through
  // These are combined into an FLV format used by the RTMP
  // -------------------------------------------------------------

  let gstreamerProg = "gst-launch-1.0";
  let gstreamerArgs = [
    "-e -m",
    `filesrc location=${global.gstreamer.sdpFilesrc} !`,
    "sdpdemux name=sdpdm timeout=0",
    "sdpdm.stream_0 ! queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! voaacenc ! mux.",
    "sdpdm.stream_1 ! queue ! rtph264depay ! h264parse ! mux.",
    `flvmux name=mux streamable=true ! rtmpsink sync=false location=${global.gstreamer.rtmpTarget}`,
  ].join(' ').trim();

  let gstreamerEnv = {
    GST_DEBUG: '2,sdpdemux:4,flvmux:4,rtmpsink:4', // log level 4 = INFO
  }

  console.log(
    `Run command: GST_DEBUG=${gstreamerEnv.GST_DEBUG} ${gstreamerProg} ${gstreamerArgs}`
  );

  let gstreamer = Process.spawn(gstreamerProg, gstreamerArgs.split(/\s+/), { env: gstreamerEnv });
  global.gstreamer.process = gstreamer;

  gstreamer.on("error", (err) => {
    console.error("Streaming process error:", err);
  });

  gstreamer.on("exit", (code, signal) => {
    console.log("Streaming process exit, code: %d, signal: %s", code, signal);

    global.gstreamer.process = null;
    stopStreaming();

    if (!signal || signal === "SIGINT") {
      console.log("Streaming stopped");
    } else {
      console.warn(
        "Streaming process didn't exit cleanly, output file might be corrupt"
      );
    }
  });

  // GStreamer writes some initial logs to stdout
  // Detect when the pipeline is playing and resolve the stream as live
  gstreamer.stdout.on("data", (chunk) => {
    out = [];
    chunk
      .toString()
      .split(/\r?\n/g)
      .filter(Boolean) // Filter out empty strings
      .forEach((line) => {
        console.log(line);
        if (line.startsWith("Setting pipeline to PLAYING")) {
          setTimeout(() => {
            streamResolve();
          }, 1000);
        }
      });
  });
 let out = []
  // GStreamer writes its progress logs to stderr
  gstreamer.stderr.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/g)
      .filter(Boolean) // Filter out empty strings
      .forEach((line) => {
        out.push(line);
        console.log(line);
      });
  });

  return streamPromise;
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
