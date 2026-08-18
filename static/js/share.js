/**
 * share.js — ZXSharer Sharer Logic
 * ==================================
 * Responsibilities:
 *  1. Request screen capture via getDisplayMedia()
 *  2. Connect to Socket.IO signaling server
 *  3. For each viewer that joins: create RTCPeerConnection, send offer, relay ICE
 *  4. Relay ICE candidates from viewers back through signaling
 *  5. Handle stream end and stop-button events
 *
 * Video data NEVER passes through the server — it flows P2P via WebRTC.
 */

"use strict";

// ── ICE / STUN configuration ──────────────────────────────────────────────────
// Uses Google's public STUN servers. For production, add TURN credentials.
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── DOM references ────────────────────────────────────────────────────────────
const localVideo        = document.getElementById("local-video");
const previewPlaceholder= document.getElementById("preview-placeholder");
const statusBadge       = document.getElementById("status-badge");
const statusText        = document.getElementById("status-text");
const btnStop           = document.getElementById("btn-stop-share");
const btnCopy           = document.getElementById("btn-copy-link");
const shareLinkInput    = document.getElementById("share-link-input");
const copyFeedback      = document.getElementById("copy-feedback");
const iconCopy          = document.getElementById("icon-copy");
const iconCheck         = document.getElementById("icon-check");
const viewerCountEl     = document.getElementById("viewer-count");
const viewerCountBadge  = document.getElementById("viewer-count-badge");
const sessionStartTime  = document.getElementById("session-start-time");
const sessionViewerCount= document.getElementById("session-viewer-count");

// ── State ─────────────────────────────────────────────────────────────────────
let localStream  = null;           // MediaStream from getDisplayMedia()
let socket       = null;           // Socket.IO connection
const peerConns  = new Map();      // viewer_sid → RTCPeerConnection
let isStopped    = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusBadge.className = `status-badge status-badge--${state}`;
  statusText.textContent = text;
}

function updateViewerCount(n) {
  viewerCountEl.textContent  = n;
  sessionViewerCount.textContent = n;
}

// ── 1. Get screen capture ─────────────────────────────────────────────────────
async function startScreenCapture() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" },
      audio: true,   // system audio if browser supports
    });
  } catch (err) {
    // User denied or browser doesn't support
    console.warn("Screen capture denied or error:", err);
    setStatus("stopped", "Permissão negada ou erro");
    if (window.showErrorModal) {
      window.showErrorModal(
        "Permissão Negada ou Erro de Captura",
        "Não foi possível acessar o compartilhamento de tela. Certifique-se de ter concedido permissão no navegador.",
        err
      );
    }
    return false;
  }

  // Show preview (mirrored via CSS transform)
  localVideo.srcObject = localStream;
  previewPlaceholder.style.display = "none";

  // Detect when user clicks the browser's built-in "Stop Sharing" button
  localStream.getVideoTracks()[0].addEventListener("ended", () => {
    stopSharing("Compartilhamento encerrado pelo navegador");
  });

  return true;
}

// ── 2. Connect to Socket.IO ───────────────────────────────────────────────────
function connectSignaling() {
  socket = io();

  socket.on("connect", () => {
    socket.emit("join_as_sharer", { session_id: SESSION_ID });
  });

  socket.on("sharer_ready", () => {
    setStatus("live", "🔴 Ao vivo");
    sessionStartTime.textContent = new Date().toLocaleTimeString("pt-BR");
  });

  // A new viewer wants a stream — create a PeerConnection and send an offer
  socket.on("new_viewer", ({ viewer_sid }) => {
    createPeerConnectionForViewer(viewer_sid);
  });

  // Viewer sent back an SDP answer
  socket.on("answer", async ({ sdp, viewer_sid }) => {
    const pc = peerConns.get(viewer_sid);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      console.error("Error setting remote description:", e);
      if (window.showErrorModal) {
        window.showErrorModal(
          "Erro WebRTC (Remote Description)",
          "Falha ao aplicar a resposta SDP enviada pelo espectador.",
          e
        );
      }
    }
  });

  // ICE candidate from a viewer
  socket.on("ice_candidate", async ({ candidate, from_sid }) => {
    const pc = peerConns.get(from_sid);
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("Error adding viewer ICE candidate:", e);
    }
  });

  // Live viewer count update from server
  socket.on("viewer_count_update", ({ count }) => {
    updateViewerCount(count);
  });

  socket.on("disconnect", () => {
    if (!isStopped) {
      setStatus("stopped", "Desconectado do servidor");
    }
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err);
    setStatus("stopped", `Erro no WebSocket`);
    if (window.showErrorModal) {
      window.showErrorModal(
        "Erro na Conexão WebSocket",
        "Ocorreu uma falha no canal de comunicação de sinalização com o servidor.",
        err
      );
    }
  });
}

// ── 3. Create RTCPeerConnection for a specific viewer ─────────────────────────
async function createPeerConnectionForViewer(viewerSid) {
  if (peerConns.has(viewerSid)) return; // already connected

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConns.set(viewerSid, pc);

  // Add all local tracks (video + audio if available)
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Send our ICE candidates to this specific viewer via server
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit("ice_candidate", {
        session_id: SESSION_ID,
        target:     "viewer",
        viewer_sid: viewerSid,
        candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      pc.close();
      peerConns.delete(viewerSid);
    }
  };

  // Create offer and send to server → viewer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", {
      session_id: SESSION_ID,
      target_sid: viewerSid,
      sdp:        pc.localDescription,
    });
  } catch (e) {
    console.error("Failed to create offer:", e);
    pc.close();
    peerConns.delete(viewerSid);
    if (window.showErrorModal) {
      window.showErrorModal(
        "Erro WebRTC (Oferta SDP)",
        "Não foi possível gerar a oferta de transmissão para o espectador.",
        e
      );
    }
  }
}

// ── 4. Stop sharing ───────────────────────────────────────────────────────────
function stopSharing(reason = "Compartilhamento encerrado") {
  if (isStopped) return;
  isStopped = true;

  // Stop all media tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  // Close all peer connections
  peerConns.forEach(pc => pc.close());
  peerConns.clear();

  // Notify server → all viewers
  if (socket && socket.connected) {
    socket.emit("sharer_stopped", { session_id: SESSION_ID });
    socket.disconnect();
  }

  setStatus("stopped", reason);
  btnStop.disabled = true;
  previewPlaceholder.style.display = "flex";
  localVideo.srcObject = null;
}

// ── 5. Copy link ──────────────────────────────────────────────────────────────
btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    iconCopy.classList.add("hidden");
    iconCheck.classList.remove("hidden");
    copyFeedback.hidden = false;
    setTimeout(() => {
      iconCopy.classList.remove("hidden");
      iconCheck.classList.add("hidden");
      copyFeedback.hidden = true;
    }, 2000);
  } catch {
    shareLinkInput.select();
    document.execCommand("copy");
  }
});

// Stop button
btnStop.addEventListener("click", () => stopSharing("Você encerrou o compartilhamento"));

// Warn before closing tab while sharing
window.addEventListener("beforeunload", (e) => {
  if (!isStopped && localStream) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  setStatus("connecting", "Solicitando permissão…");
  const ok = await startScreenCapture();
  if (!ok) return;
  setStatus("connecting", "Conectando ao servidor…");
  connectSignaling();
})();
