"use strict";
// Multi‑view client – handles multiple independent viewer sessions.

// Reuse the same STUN configuration as share.js
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const grid = document.getElementById("multiview-grid");
const input = document.getElementById("session-id-input");
const addBtn = document.getElementById("btn-add-stream");

// Map of sessionId -> {socket, pc, wrapper, video}
const sessions = {};

addBtn.addEventListener("click", () => {
  const id = input.value.trim();
  if (!id) return;
  if (sessions[id]) {
    console.warn(`Session ${id} already added`);
    return;
  }
  addSession(id);
  input.value = "";
});

function addSession(sessionId) {
  // --- DOM elements ---
  const wrapper = document.createElement("div");
  wrapper.className = "multiview-item";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.className = "remote-video";
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.title = "Remove this stream";
  removeBtn.innerHTML = "✕";
  wrapper.appendChild(video);
  wrapper.appendChild(removeBtn);
  grid.appendChild(wrapper);

  // --- WebRTC / Socket.io ---
  const socket = io();
  const pc = new RTCPeerConnection(RTC_CONFIG);

  sessions[sessionId] = { socket, pc, wrapper, video };

  // Signaling flow – mirror view.js logic
  socket.on("connect", () => socket.emit("join_as_viewer", { session_id: sessionId }));

  socket.on("offer", async ({ sdp }) => {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { session_id: sessionId, sdp: pc.localDescription });
    } catch (e) {
      console.error(`Error handling offer for ${sessionId}:`, e);
      // Show a simple overlay/message inside this wrapper
      const errOverlay = document.createElement("div");
      errOverlay.className = "error-overlay";
      errOverlay.textContent = "Error connecting";
      wrapper.appendChild(errOverlay);
    }
  });

  socket.on("ice_candidate", async ({ candidate }) => {
    if (!candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn(`ICE candidate error for ${sessionId}:`, e);
    }
  });

  socket.on("sharer_stopped", cleanUp);
  socket.on("session_not_found", cleanUp);

  pc.ontrack = (event) => {
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit("ice_candidate", {
        session_id: sessionId,
        target: "sharer",
        candidate,
      });
    }
  };

  // Remove button – stop this session only
  removeBtn.addEventListener("click", cleanUp);

  function cleanUp() {
    if (pc) pc.close();
    if (socket && socket.connected) socket.disconnect();
    if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    delete sessions[sessionId];
  }
}
