"""
zuirx share — Real-time Screen Sharing via WebRTC + Flask
=========================================================
The server is responsible for:
  1. Serving HTML pages
  2. Creating and managing sessions
  3. WebRTC signaling (relaying SDP offer/answer and ICE candidates)

Video never passes through this server. It flows P2P between browsers via WebRTC.
"""

import os
import secrets
import time
from flask import Flask, render_template, jsonify, abort, request
from flask_socketio import SocketIO, emit, join_room, leave_room

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = secrets.token_hex(32)

# async_mode="threading" works for local development without eventlet.
# For production, use gunicorn with an eventlet/gevent worker class.
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

# ---------------------------------------------------------------------------
# In-memory session store
# {session_id: {"sharer_sid": str | None, "created_at": float, "viewer_count": int}}
# ---------------------------------------------------------------------------
sessions: dict[str, dict] = {}

SESSION_TTL_SECONDS = 3600  # 1 hour — sessions older than this are pruned


def _prune_old_sessions() -> None:
    """Remove sessions that have been inactive for more than SESSION_TTL_SECONDS."""
    now = time.time()
    expired = [
        sid for sid, data in sessions.items()
        if now - data["created_at"] > SESSION_TTL_SECONDS
    ]
    for sid in expired:
        sessions.pop(sid, None)


# ---------------------------------------------------------------------------
# HTTP Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/share/<session_id>")
def share(session_id: str):
    """Sharer page — shows preview, link, and viewer count."""
    # Session may not exist yet if the user lands here directly; that's fine,
    # share.js will create it via Socket.IO on connect.
    return render_template("share.html", session_id=session_id)


@app.route("/view/<session_id>")
def view(session_id: str):
    """Viewer page — shows the incoming video stream."""
    return render_template("view.html", session_id=session_id)


@app.route("/api/create-session", methods=["POST"])
def create_session():
    """Generate a cryptographically random session ID and register it."""
    _prune_old_sessions()
    session_id = secrets.token_hex(16)  # 32 hex chars — practically unguessable
    sessions[session_id] = {
        "sharer_sid": None,
        "created_at": time.time(),
        "viewer_count": 0,
    }
    return jsonify({"session_id": session_id})


@app.route("/api/session/<session_id>/status")
def session_status(session_id: str):
    """Return whether a session is active (has a connected sharer)."""
    data = sessions.get(session_id)
    if data is None:
        return jsonify({"exists": False, "active": False})
    active = data["sharer_sid"] is not None
    return jsonify({"exists": True, "active": active, "viewer_count": data["viewer_count"]})


@app.errorhandler(404)
def handle_404(e):
    return jsonify({
        "error": "Not Found",
        "message": "A rota ou recurso solicitado não existe no servidor.",
        "technical_details": {
            "code": 404,
            "description": str(e)
        }
    }), 404


@app.errorhandler(500)
def handle_500(e):
    import traceback
    return jsonify({
        "error": "Internal Server Error",
        "message": "Ocorreu um erro interno no servidor Flask.",
        "technical_details": {
            "code": 500,
            "description": str(e),
            "traceback": traceback.format_exc()
        }
    }), 500


# ---------------------------------------------------------------------------
# Socket.IO — Signaling events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    pass  # Nothing to do on bare connect


@socketio.on("disconnect")
def on_disconnect(reason=None):
    """
    When any socket disconnects, check if it was a sharer.
    If so, notify all viewers in that session room.
    """
    sid = request.sid
    for session_id, data in list(sessions.items()):
        if data.get("sharer_sid") == sid:
            data["sharer_sid"] = None
            # Broadcast to every viewer listening in this session's room
            emit("sharer_stopped", {}, room=session_id, include_self=False)
            break


@socketio.on("join_as_sharer")
def on_join_as_sharer(payload: dict):
    """
    Emitted by the sharer browser when it loads the share page.
    Registers the sharer's socket ID for this session.
    """
    session_id = payload.get("session_id", "")
    if session_id not in sessions:
        emit("error", {"message": "Session not found"})
        return

    sessions[session_id]["sharer_sid"] = request.sid
    # The sharer joins its own room so it can receive messages targeted at it
    join_room(f"sharer_{session_id}")
    emit("sharer_ready", {"session_id": session_id})


@socketio.on("join_as_viewer")
def on_join_as_viewer(payload: dict):
    """
    Emitted by a viewer browser when it loads the view page.
    Joins the session room and notifies the sharer to create an offer.
    """
    session_id = payload.get("session_id", "")
    data = sessions.get(session_id)

    if data is None:
        emit("session_not_found", {})
        return

    if data["sharer_sid"] is None:
        emit("sharer_not_ready", {})
        return

    viewer_sid = request.sid
    join_room(session_id)  # viewer joins the session's broadcast room

    # Increment viewer count
    data["viewer_count"] += 1
    viewer_count = data["viewer_count"]

    # Tell the sharer: "a new viewer wants a stream — send them an offer"
    emit(
        "new_viewer",
        {"viewer_sid": viewer_sid},
        room=f"sharer_{session_id}",
    )
    # Update viewer count for the sharer
    emit(
        "viewer_count_update",
        {"count": viewer_count},
        room=f"sharer_{session_id}",
    )


@socketio.on("viewer_left")
def on_viewer_left(payload: dict):
    """Viewer notifies server it is leaving (tab close / navigate away)."""
    session_id = payload.get("session_id", "")
    data = sessions.get(session_id)
    if data:
        data["viewer_count"] = max(0, data["viewer_count"] - 1)
        emit(
            "viewer_count_update",
            {"count": data["viewer_count"]},
            room=f"sharer_{session_id}",
        )
    leave_room(session_id)


@socketio.on("offer")
def on_offer(payload: dict):
    """
    Sharer sends an SDP offer for a specific viewer.
    Server relays it directly to that viewer's socket.
    """
    target_sid = payload.get("target_sid")
    sdp = payload.get("sdp")
    session_id = payload.get("session_id")
    emit("offer", {"sdp": sdp, "session_id": session_id}, room=target_sid)


@socketio.on("answer")
def on_answer(payload: dict):
    """
    Viewer sends an SDP answer back to the sharer.
    Server relays it to the sharer's room for this session.
    """
    session_id = payload.get("session_id")
    sdp = payload.get("sdp")
    viewer_sid = request.sid
    emit(
        "answer",
        {"sdp": sdp, "viewer_sid": viewer_sid},
        room=f"sharer_{session_id}",
    )


@socketio.on("ice_candidate")
def on_ice_candidate(payload: dict):
    """
    Relay ICE candidates between sharer and a specific viewer (or vice-versa).
    The 'target' field tells the server which socket to forward to.
    """
    target = payload.get("target")
    candidate = payload.get("candidate")
    session_id = payload.get("session_id")

    if target == "sharer":
        # Viewer is sending an ICE candidate to the sharer
        viewer_sid = request.sid
        emit(
            "ice_candidate",
            {"candidate": candidate, "from_sid": viewer_sid},
            room=f"sharer_{session_id}",
        )
    else:
        # Sharer is sending an ICE candidate to a specific viewer
        viewer_sid = payload.get("viewer_sid")
        emit(
            "ice_candidate",
            {"candidate": candidate},
            room=viewer_sid,
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    print(f"\n[*] zuirx share running at http://localhost:{port}\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=debug, use_reloader=False, allow_unsafe_werkzeug=True)
