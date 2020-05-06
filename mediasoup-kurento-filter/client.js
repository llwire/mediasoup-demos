"use strict";

const CONFIG = require("./config");
const MediasoupClient = require("mediasoup-client");
const KurentoUtils = require("kurento-utils");
const SocketClient = require("socket.io-client");
const SocketPromise = require("socket.io-promise").default;

window.kurento = KurentoUtils;
// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    socket: null,
  },

  kurento: {
    device: null,
    peers: {
      send: null,
      recv: null,
    },
  },

  mediasoup: {
    device: null,

    // WebRTC connection with mediasoup
    webrtc: {
      sendTransport: null,
      audioProducer: null,
      videoProducer: null,

      recvTransport: null,
      audioConsumer: null,
      videoConsumer: null,
    },
  },
};

// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  console: document.getElementById("uiConsole"),

  // <button>
  startWebRTC: document.getElementById("uiStartWebRTC"),
  startCast: document.getElementById("uiStartCast"),
  debug: document.getElementById("uiDebug"),

  // <video>
  localVideo: document.getElementById("uiLocalVideo"),
  remoteVideo: document.getElementById("uiRemoteVideo"),
};

ui.startWebRTC.onclick = startWebRTC;
// ui.startWebRTC.onclick = startPresenterStream;
ui.startCast.onclick = startCast;
ui.debug.onclick = () => {
  if (global.server.socket) {
    global.server.socket.emit("DEBUG");
  }
};

// ----------------------------------------------------------------------------

window.addEventListener("load", function () {
  console.log("Page load, connect WebSocket");
  connectSocket();

  if ("adapter" in window) {
    console.log(
      // eslint-disable-next-line no-undef
      `webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn("webrtc-adapter is not loaded! an install or config issue?");
  }
});

window.addEventListener("beforeunload", function () {
  console.log("Page unload, close WebSocket");
  global.server.socket.close();
});

// ----

function connectSocket() {
  const serverUrl = `https://${window.location.host}`;

  console.log("Connect with Application Server:", serverUrl);

  const socket = SocketClient(serverUrl, {
    path: CONFIG.https.wsPath,
    transports: ["websocket"],
  });
  global.server.socket = socket;

  socket.on("connect", () => {
    console.log("WebSocket connected");
  });

  socket.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  socket.on("LOG", (log) => {
    ui.console.value += log + "\n";
    ui.console.scrollTop = ui.console.scrollHeight;
  });

  socket.on("CAST_READY", () => {
    ui.startCast.disabled = false;
    ui.debug.disabled = false;
  });

  socket.on("ICE_CANDIDATE", (candidate) => {
    console.log(candidate);
    global.kurento.peer.addIceCandidate(candidate);
  });
}

// ----------------------------------------------------------------------------

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");
  await startPresenterStream();
}

// ----

async function startPresenterStream() {
  const socket = global.server.socket;
  const socketRequest = SocketPromise(socket);
  const offerHandler = async function(err, sdpOffer) {
    const response = await socketRequest({ type: "START_PRESENTER", sdpOffer: sdpOffer });
    const sdpAnswer = response.data;

    console.log('sdp Answer', sdpAnswer);
    await peer.processAnswer(sdpAnswer);
  };

  const onIceCandidate = async function(candidate) {
    await socketRequest({ type: "ICE_CANDIDATE", candidate: candidate });
  };

  const options = {
    localVideo: ui.localVideo,
    remoteVideo: ui.remoteVideo,
    mediaConstraints: {
      audio: true,
      video: {
        width: {min: 640, ideal: 800, max: 1080},
        height: {min: 480, ideal: 600, max: 810},
        frameRate: 30,
      },
    },
    onicecandidate: onIceCandidate,
  };

  const peer = await KurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, async function(e){
    global.kurento.peer = peer;

    await peer.generateOffer(offerHandler);
  });
}

// ----

async function addIceCandidate(peer, candidate) {
  await peer.addIceCandidate(candidate);
}

// ----------------------------------------------------------------------------

async function startCast() {
  const socket = global.server.socket;

  // Start an (S)RTP transport as required

  const uiTransport = document.querySelector(
    "input[name='uiTransport']:checked"
  ).value;
  let enableSrtp = false;
  if (uiTransport.indexOf("srtp") !== -1) {
    enableSrtp = true;
  }

  const socketRequest = SocketPromise(socket);
  await socketRequest({ type: "START_CAST", enableSrtp: enableSrtp });
}

// ----------------------------------------------------------------------------
