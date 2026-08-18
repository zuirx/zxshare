/**
 * view.js — ZXSharer Viewer Logic
 * ==================================
 * Responsibilities:
 *  1. Connect to Socket.IO and join as a viewer for SESSION_ID
 *  2. Wait for the server to relay an SDP offer from the sharer
 *  3. Create RTCPeerConnection, set remote description, create answer
 *  4. Relay ICE candidates back to the sharer through the server
 *  5. Attach the incoming video stream to the <video> element
 *  6. Handle "sharer stopped" and "session not found" states gracefully
 *
 * Video data flows P2P — the server only relays signaling messages.
 */

"use strict";

// ── ICE / STUN configuration ──────────────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── DOM references ────────────────────────────────────────────────────────────
const remoteVideo         = document.getElementById("remote-video");
const videoWrap           = document.getElementById("video-wrap");
const overlayConnecting   = document.getElementById("overlay-connecting");
const overlayNotFound     = document.getElementById("overlay-not-found");
const overlayEnded        = document.getElementById("overlay-ended");
const btnFullscreen       = document.getElementById("btn-fullscreen");
const iconExpand          = document.getElementById("icon-expand");
const iconCompress        = document.getElementById("icon-compress");

// ── State ─────────────────────────────────────────────────────────────────────
let socket = null;
let pc     = null;   // RTCPeerConnection with the sharer

// ── Overlay control ───────────────────────────────────────────────────────────
function showOverlay(which) {
  // which: "connecting" | "not-found" | "ended" | "none"
  overlayConnecting.hidden = which !== "connecting";
  overlayNotFound.hidden   = which !== "not-found";
  overlayEnded.hidden      = which !== "ended";
  videoWrap.hidden         = which !== "none";
}

// ── Fullscreen toggle ─────────────────────────────────────────────────────────
btnFullscreen.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    videoWrap.requestFullscreen().catch(console.warn);
  } else {
    document.exitFullscreen().catch(console.warn);
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFs = !!document.fullscreenElement;
  iconExpand.classList.toggle("hidden", isFs);
  iconCompress.classList.toggle("hidden", !isFs);
});

// ── WebRTC — create peer connection ──────────────────────────────────────────
function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  // Relay our ICE candidates to the sharer via server
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit("ice_candidate", {
        session_id: SESSION_ID,
        target:     "sharer",   // server routes to sharer room
        candidate,
      });
    }
  };

  // When remote tracks arrive, attach to <video>
  pc.ontrack = (event) => {
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      showOverlay("none"); // hide connecting overlay, show video
    }
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case "failed":
      case "closed":
        showOverlay("ended");
        break;
      case "disconnected":
        // Give a brief grace period before showing ended overlay
        setTimeout(() => {
          if (pc && ["disconnected", "failed", "closed"].includes(pc.connectionState)) {
            showOverlay("ended");
          }
        }, 3000);
        break;
    }
  };

  return pc;
}

// ── Socket.IO signaling ───────────────────────────────────────────────────────
function connectSignaling() {
  socket = io();

  socket.on("connect", () => {
    // Join this session as a viewer
    socket.emit("join_as_viewer", { session_id: SESSION_ID });
  });

  // Session doesn't exist on the server
  socket.on("session_not_found", () => {
    showOverlay("not-found");
    if (window.showErrorModal) {
      window.showErrorModal(
        "Sessão Não Encontrada",
        "A sessão de compartilhamento informada não existe ou já expirou.",
        { session_id: SESSION_ID, status: 404, message: "Session ID does not exist on server." }
      );
    }
    socket.disconnect();
  });

  // Session exists but sharer isn't connected yet — poll
  socket.on("sharer_not_ready", () => {
    // Retry joining after a short delay
    setTimeout(() => {
      if (socket.connected) {
        socket.emit("join_as_viewer", { session_id: SESSION_ID });
      }
    }, 3000);
  });

  // Sharer sends us an SDP offer via server relay
  socket.on("offer", async ({ sdp }) => {
    createPeerConnection();

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("answer", {
        session_id: SESSION_ID,
        sdp:        pc.localDescription,
      });
    } catch (e) {
      console.error("Error handling offer:", e);
      showOverlay("ended");
      if (window.showErrorModal) {
        window.showErrorModal(
          "Erro na Transmissão WebRTC",
          "Ocorreu uma falha ao negociar a conexão de vídeo com o compartilhador.",
          e
        );
      }
    }
  });

  // ICE candidate from sharer
  socket.on("ice_candidate", async ({ candidate }) => {
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("Error adding sharer ICE candidate:", e);
    }
  });

  // Sharer disconnected — show ended overlay
  socket.on("sharer_stopped", () => {
    if (pc) { pc.close(); pc = null; }
    showOverlay("ended");
    socket.disconnect();
  });

  socket.on("disconnect", () => {
    // If we still had a video, the connection dropped unexpectedly
    if (!videoWrap.hidden) {
      showOverlay("ended");
    }
  });
}

// ── Notify server on page leave ───────────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  if (socket && socket.connected) {
    socket.emit("viewer_left", { session_id: SESSION_ID });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
showOverlay("connecting");
connectSignaling();
