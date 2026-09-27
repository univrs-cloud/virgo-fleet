import eventEmitter from './event_emitter.js';

/**
 * Live sockets, keyed by the session that authenticated them.
 *
 * Sockets authenticate once at connect and are never re-checked, so deleting a session row leaves
 * an already-open socket fully authenticated until it happens to reconnect. Every namespace
 * authenticates through applyFleetUserSession, which is the single place that registers here, so
 * this covers the fleet namespaces and the proxied node ones alike.
 */
const SWEEP_MS = 60 * 1000;
const REVOKED_RETENTION_MS = 5 * 60 * 1000;

const socketsBySessionId = new Map();
const expiresAtBySessionId = new Map();
const revokedAtBySessionId = new Map();
let sweepInterval = null;

function forget(sessionId) {
	socketsBySessionId.delete(sessionId);
	expiresAtBySessionId.delete(sessionId);
}

function untrack(socket) {
	const sessionId = socket.sessionId;
	const tracked = socketsBySessionId.get(sessionId);
	if (!tracked) {
		return;
	}
	tracked.delete(socket);
	if (!tracked.size) {
		forget(sessionId);
	}
}

function close(socket) {
	if (socket.connected) {
		socket.disconnect(true);
		return;
	}
	socket.conn?.close();
}

function sweep() {
	const now = Date.now();
	for (const [sessionId, revokedAt] of revokedAtBySessionId) {
		if (now - revokedAt > REVOKED_RETENTION_MS) {
			revokedAtBySessionId.delete(sessionId);
		}
	}
	for (const sockets of socketsBySessionId.values()) {
		for (const socket of sockets) {
			if (!socket.connected && socket.conn?.readyState !== 'open') {
				untrack(socket);
			}
		}
	}
	const expired = [];
	for (const [sessionId, expiresAt] of expiresAtBySessionId) {
		if (expiresAt <= now) {
			expired.push(sessionId);
		}
	}
	if (expired.length) {
		eventEmitter.emit('sessions:revoked', { sessionIds: expired });
	}
}

function startSweep() {
	if (sweepInterval) {
		return;
	}
	sweepInterval = setInterval(sweep, SWEEP_MS);
	sweepInterval.unref?.();
}

function track(socket, sessionId, expiresAt) {
	if (!sessionId) {
		return;
	}
	socket.sessionId = sessionId;
	if (revokedAtBySessionId.has(sessionId)) {
		close(socket);
		return;
	}
	const sockets = socketsBySessionId.get(sessionId) ?? new Set();
	sockets.add(socket);
	socketsBySessionId.set(sessionId, sockets);
	if (expiresAt) {
		expiresAtBySessionId.set(sessionId, new Date(expiresAt).getTime());
	}
	startSweep();
	socket.on('disconnect', () => {
		untrack(socket);
	});
}

/** Must be called after the rows are deleted, so a client that reconnects immediately can no longer
 * authenticate. */
function disconnectSessions(sessionIds) {
	const now = Date.now();
	for (const sessionId of sessionIds) {
		revokedAtBySessionId.set(sessionId, now);
		const sockets = [...(socketsBySessionId.get(sessionId) ?? [])];
		forget(sessionId);
		for (const socket of sockets) {
			close(socket);
		}
	}
	startSweep();
}

export {
	track,
	untrack,
	disconnectSessions
};
