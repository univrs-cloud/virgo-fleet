/**
 * Live sockets, keyed by the session that authenticated them.
 *
 * Sockets authenticate once at connect and are never re-checked, so deleting a session row leaves
 * an already-open socket fully authenticated until it happens to reconnect. Every namespace
 * authenticates through applyFleetUserSession, which is the single place that registers here, so
 * this covers the fleet namespaces and the proxied node ones alike.
 */
const socketsBySessionId = new Map();

function track(socket, sessionId) {
	if (!sessionId) {
		return;
	}
	socket.sessionId = sessionId;
	const sockets = socketsBySessionId.get(sessionId) ?? new Set();
	sockets.add(socket);
	socketsBySessionId.set(sessionId, sockets);
	socket.on('disconnect', () => {
		const tracked = socketsBySessionId.get(sessionId);
		if (!tracked) {
			return;
		}
		tracked.delete(socket);
		if (!tracked.size) {
			socketsBySessionId.delete(sessionId);
		}
	});
}

/** Must be called after the rows are deleted, so a client that reconnects immediately can no longer
 * authenticate. */
function disconnectSessions(sessionIds) {
	for (const sessionId of sessionIds) {
		for (const socket of [...(socketsBySessionId.get(sessionId) ?? [])]) {
			socket.disconnect(true);
		}
		socketsBySessionId.delete(sessionId);
	}
}

export {
	track,
	disconnectSessions
};
