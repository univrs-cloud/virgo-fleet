import { randomUUID } from 'crypto';
import { fleetNamespaceMiddleware } from './fleet_namespace.js';
import { createRateLimiter, getSocketClientAddress } from './socket_rate_limit.js';
import { iceServers } from './turn.js';
import { mintNodeSessionToken } from './node_authz_token.js';
import { getNodeSocket, getNodeCapabilities } from './node_registry.js';
import DataService from '../services/data_service.js';

// Signaling for the browser <-> node WebRTC data channel that carries a node page's namespace
// traffic (and, later, its static assets). Fleet only relays SDP and ICE candidates between an
// authenticated browser and the target node's control socket; the media/data path is direct
// (or via coturn for a CGNAT node) and never touches this process.
//
// A dedicated namespace `/fleet/{nodeId}/signal` is used, registered BEFORE the broader
// `registerFleetProxy` matcher so this exact suffix wins. Auth reuses the fleet session cookie
// and per-node access check, exactly like the Socket.IO proxy, so a WebRTC session is authorised
// on the same terms and (below) torn down at the same moments.

const SIGNAL_NAMESPACE_PATTERN = /^\/fleet\/[^/]+\/signal$/;
// One browser page needs one peer connection; a couple more covers an in-flight replacement during
// an ICE restart. Past that it is a misbehaving client, not a real need.
const MAX_SESSIONS_PER_SOCKET = 4;
const SESSION_REQUEST_WINDOW_MS = 60 * 1000;
const NEGOTIATION_TIMEOUT_MS = 30 * 1000;
const NODE_OFFLINE_GRACE_MS = 60 * 1000;

const SESSION_STATE = Object.freeze({
	REQUESTED: 'REQUESTED',
	OPEN_SENT: 'OPEN_SENT',
	OFFER_RECEIVED: 'OFFER_RECEIVED',
	ANSWERED: 'ANSWERED',
	CONNECTED: 'CONNECTED',
	CLOSING: 'CLOSING',
	CLOSED: 'CLOSED'
});
const SESSION_STATE_ORDER = Object.freeze(Object.values(SESSION_STATE).reduce((result, state, index) => {
	result[state] = index;
	return result;
}, {}));

const transitionSession = (session, nextState) => {
	if (!session || SESSION_STATE_ORDER[nextState] < SESSION_STATE_ORDER[session.state]) {
		return false;
	}
	session.state = nextState;
	session.stateChangedAt = Date.now();
	return true;
};

const sessionRequestLimiter = createRateLimiter({ windowMs: SESSION_REQUEST_WINDOW_MS, max: 60 });

// sessionId -> { clientSocket, nodeSocket, nodeId, userId, state, negotiationTimer, orphanTimer }
const sessions = new Map();
// nodeId -> Set<sessionId>, userId -> Set<sessionId>: reverse indexes for the teardown hooks.
const sessionsByNodeId = new Map();
const sessionsByUserId = new Map();
const signalSocketsByNodeId = new Map();
const pendingResumes = new Map();
const sessionsByClient = new Map();

const indexAdd = (map, key, value) => {
	if (key === null || key === undefined) {
		return;
	}
	if (!map.has(key)) {
		map.set(key, new Set());
	}
	map.get(key).add(value);
};

const indexRemove = (map, key, value) => {
	const set = map.get(key);
	if (!set) {
		return;
	}
	set.delete(value);
	if (!set.size) {
		map.delete(key);
	}
};

/** Drops a session's bookkeeping. Does not emit anything — callers decide whether the node and/or
 * the browser still need to be told. */
const forgetSession = (sessionId) => {
	const session = sessions.get(sessionId);
	if (!session) {
		return;
	}
	transitionSession(session, SESSION_STATE.CLOSING);
	clearTimeout(session.negotiationTimer);
	clearTimeout(session.orphanTimer);
	session.negotiationTimer = null;
	session.orphanTimer = null;
	sessions.delete(sessionId);
	indexRemove(sessionsByNodeId, session.nodeId, sessionId);
	indexRemove(sessionsByUserId, session.userId, sessionId);
	indexRemove(sessionsByClient, session.clientSocket, sessionId);
	transitionSession(session, SESSION_STATE.CLOSED);
};

const countSessionsForClient = (clientSocket) => {
	return sessionsByClient.get(clientSocket)?.size ?? 0;
};

const reassignSessionClient = (session, sessionId, clientSocket) => {
	indexRemove(sessionsByClient, session.clientSocket, sessionId);
	session.clientSocket = clientSocket;
	indexAdd(sessionsByClient, clientSocket, sessionId);
};

const tellSessionNode = (session, event, payload) => {
	if (!session) {
		return;
	}
	const nodeSocket = session.nodeSocket?.connected ? session.nodeSocket : getNodeSocket(session.nodeId);
	if (nodeSocket?.connected) {
		nodeSocket.emit(event, payload);
	}
};

const closeSession = (sessionId, { reason, tellNode = true } = {}) => {
	const session = sessions.get(sessionId);
	if (!session) {
		return;
	}
	if (tellNode) {
		tellSessionNode(session, 'webrtc:close', { sessionId });
	}
	session.clientSocket.emit('webrtc:close', { sessionId, ...(reason ? { reason } : {}) });
	forgetSession(sessionId);
};

const refreshOrphanState = (session, sessionId) => {
	const nodeOnline = Boolean(session.nodeSocket?.connected || getNodeSocket(session.nodeId)?.connected);
	const clientOnline = Boolean(session.clientSocket?.connected);
	if (nodeOnline && clientOnline) {
		clearTimeout(session.orphanTimer);
		session.orphanTimer = null;
		return;
	}
	if (session.orphanTimer) {
		return;
	}
	session.orphanTimer = setTimeout(() => {
		session.orphanTimer = null;
		closeSession(sessionId, { reason: 'node-offline' });
	}, NODE_OFFLINE_GRACE_MS);
	session.orphanTimer.unref?.();
};

const adoptSession = ({ sessionId, nodeId, nodeSocket, clientSocket }) => {
	const session = {
		clientSocket,
		nodeSocket,
		nodeId,
		userId: clientSocket.userId,
		state: SESSION_STATE.CONNECTED,
		stateChangedAt: Date.now(),
		negotiationTimer: null,
		orphanTimer: null
	};
	sessions.set(sessionId, session);
	indexAdd(sessionsByNodeId, nodeId, sessionId);
	indexAdd(sessionsByUserId, session.userId, sessionId);
	indexAdd(sessionsByClient, clientSocket, sessionId);
	recheckSessionAccess(sessionId).catch((error) => {
		console.error('Error re-checking WebRTC session access:', error);
	});
};

const dropPendingResume = (sessionId) => {
	const pending = pendingResumes.get(sessionId);
	if (!pending) {
		return;
	}
	clearTimeout(pending.timer);
	pendingResumes.delete(sessionId);
};

const offerResume = (sessionId, nodeId, half) => {
	let pending = pendingResumes.get(sessionId);
	if (pending && pending.nodeId !== nodeId) {
		dropPendingResume(sessionId);
		pending = null;
	}
	if (!pending) {
		pending = { nodeId, nodeSocket: null, clientSocket: null, timer: null };
		pending.timer = setTimeout(() => {
			pendingResumes.delete(sessionId);
			if (pending.nodeSocket?.connected) {
				pending.nodeSocket.emit('webrtc:close', { sessionId });
			}
			pending.clientSocket?.emit('webrtc:close', { sessionId, reason: 'node-offline' });
		}, NODE_OFFLINE_GRACE_MS);
		pending.timer.unref?.();
		pendingResumes.set(sessionId, pending);
	}
	Object.assign(pending, half);
	if (!pending.nodeSocket || !pending.clientSocket) {
		return false;
	}
	dropPendingResume(sessionId);
	adoptSession({ sessionId, nodeId, nodeSocket: pending.nodeSocket, clientSocket: pending.clientSocket });
	return true;
};

const recheckSessionAccess = async (sessionId) => {
	const session = sessions.get(sessionId);
	if (!session) {
		return;
	}
	const allowed = await DataService.canUserAccessNode(session.userId, session.nodeId);
	if (!allowed && sessions.has(sessionId)) {
		closeSession(sessionId, { reason: 'access-revoked' });
	}
};

/** Attaches the node-side signaling listeners to a node's control socket, once. Mirrors
 * attachNodeAssetHandler — the node answers offers, trickles its candidates, and reports failures
 * over the same `/node` socket it already holds. Each handler checks the session belongs to this
 * node, so one node's socket can never inject signaling into another's session. */
const attachNodeWebrtcSignaling = (nodeSocket) => {
	if (nodeSocket.data?.webrtcSignalingAttached) {
		return;
	}
	nodeSocket.data.webrtcSignalingAttached = true;

	const relayToClient = (event) => {
		return ({ sessionId, ...rest } = {}) => {
			const session = sessions.get(sessionId);
			if (!session || session.nodeId !== nodeSocket.data.nodeId) {
				return;
			}
			if (event === 'webrtc:answer') {
				if (session.state !== SESSION_STATE.OFFER_RECEIVED) {
					return;
				}
				transitionSession(session, SESSION_STATE.ANSWERED);
			}
			session.clientSocket.emit(event, { sessionId, ...rest });
			if (event === 'webrtc:close' || event === 'webrtc:error') {
				forgetSession(sessionId);
			}
		};
	};

	nodeSocket.on('webrtc:answer', relayToClient('webrtc:answer'));
	nodeSocket.on('webrtc:candidate', relayToClient('webrtc:candidate'));
	nodeSocket.on('webrtc:close', relayToClient('webrtc:close'));
	nodeSocket.on('webrtc:error', relayToClient('webrtc:error'));
	nodeSocket.on('webrtc:connected', ({ sessionId } = {}) => {
		const session = sessions.get(sessionId);
		if (!session || session.nodeId !== nodeSocket.data.nodeId) {
			return;
		}
		transitionSession(session, SESSION_STATE.CONNECTED);
		clearTimeout(session.negotiationTimer);
		session.negotiationTimer = null;
	});
	nodeSocket.on('webrtc:sessions', ({ sessionIds } = {}) => {
		const nodeId = nodeSocket.data.nodeId;
		const announced = new Set(Array.isArray(sessionIds) ? sessionIds : []);
		for (const sessionId of announced) {
			const session = sessions.get(sessionId);
			if (!session) {
				offerResume(sessionId, nodeId, { nodeSocket });
				continue;
			}
			if (session.nodeId !== nodeId) {
				nodeSocket.emit('webrtc:close', { sessionId });
				continue;
			}
			session.nodeSocket = nodeSocket;
			refreshOrphanState(session, sessionId);
			recheckSessionAccess(sessionId).catch((error) => {
				console.error('Error re-checking WebRTC session access:', error);
			});
		}
		for (const sessionId of [...(sessionsByNodeId.get(nodeId) ?? [])]) {
			const session = sessions.get(sessionId);
			if (session?.state === SESSION_STATE.CONNECTED && !announced.has(sessionId)) {
				closeSession(sessionId, { reason: 'node-offline', tellNode: false });
			}
		}
	});
};

const handleSessionRequest = async (clientSocket, nodeId, ack) => {
	if (countSessionsForClient(clientSocket) >= MAX_SESSIONS_PER_SOCKET) {
		ack({ status: 'failed', message: 'Too many WebRTC sessions.' });
		return;
	}
	if (!getNodeSocket(nodeId)?.connected) {
		ack({ status: 'failed', message: 'Node is offline.' });
		return;
	}
	if (!getNodeCapabilities(nodeId)?.webrtc) {
		ack({ status: 'failed', message: 'Node does not support WebRTC.' });
		return;
	}
	const [allowed, nodeToken] = await Promise.all([
		DataService.canUserAccessNode(clientSocket.userId, nodeId),
		DataService.getNodeToken(nodeId)
	]);
	if (!allowed) {
		ack({ status: 'failed', message: 'Access denied for node.' });
		clientSocket.disconnect(true);
		return;
	}
	if (!nodeToken) {
		ack({ status: 'failed', message: 'Node is not registered.' });
		return;
	}
	if (!clientSocket.connected) {
		return;
	}
	if (countSessionsForClient(clientSocket) >= MAX_SESSIONS_PER_SOCKET) {
		ack({ status: 'failed', message: 'Too many WebRTC sessions.' });
		return;
	}
	const nodeSocket = getNodeSocket(nodeId);
	if (!nodeSocket?.connected) {
		ack({ status: 'failed', message: 'Node is offline.' });
		return;
	}
	const sessionId = randomUUID();
	const servers = iceServers(clientSocket.userId);
	const token = mintNodeSessionToken({
		nodeId,
		sessionId,
		userId: clientSocket.userId,
		email: clientSocket.email,
		nodeToken
	});

	const session = {
		clientSocket,
		nodeSocket,
		nodeId,
		userId: clientSocket.userId,
		state: SESSION_STATE.REQUESTED,
		stateChangedAt: Date.now(),
		negotiationTimer: null,
		orphanTimer: null
	};
	sessions.set(sessionId, session);
	indexAdd(sessionsByNodeId, nodeId, sessionId);
	indexAdd(sessionsByUserId, clientSocket.userId, sessionId);
	indexAdd(sessionsByClient, clientSocket, sessionId);

	nodeSocket.emit('webrtc:open', { sessionId, token, iceServers: servers });
	transitionSession(session, SESSION_STATE.OPEN_SENT);
	session.negotiationTimer = setTimeout(() => {
		const current = sessions.get(sessionId);
		if (!current || current.state === SESSION_STATE.CONNECTED) {
			return;
		}
		closeSession(sessionId, { reason: 'negotiation-timeout' });
	}, NEGOTIATION_TIMEOUT_MS);
	session.negotiationTimer.unref?.();
	ack({ status: 'succeeded', sessionId, iceServers: servers, token });
};

/** Registers the `/fleet/{nodeId}/signal` namespace. Must run before registerFleetProxy so the
 * `/signal` suffix is matched here and not swallowed by the generic proxy matcher. */
const registerWebrtcSignaling = (io) => {
	const signalNsp = io.of(SIGNAL_NAMESPACE_PATTERN);

	signalNsp.use(fleetNamespaceMiddleware);

	signalNsp.on('connection', (clientSocket) => {
		const nodeId = clientSocket.data.nodeId;
		indexAdd(signalSocketsByNodeId, nodeId, clientSocket);

		// socket.io delivers a bare ack callback when the client emits with no payload, or
		// (payload, ack) when it sends one — accept either.
		clientSocket.on('webrtc:session:request', (...args) => {
			const ack = args.find((arg) => { return typeof arg === 'function'; });
			if (!ack) {
				return;
			}
			if (!sessionRequestLimiter.consume(getSocketClientAddress(clientSocket))) {
				ack({ status: 'failed', message: 'Too many requests.' });
				return;
			}
			handleSessionRequest(clientSocket, nodeId, ack).catch((error) => {
				console.error('Error starting WebRTC session:', error);
				ack({ status: 'failed', message: 'Could not start session.' });
			});
		});

		clientSocket.on('webrtc:offer', ({ sessionId, sdp, token } = {}) => {
			const session = sessions.get(sessionId);
			if (session?.clientSocket === clientSocket && session.state === SESSION_STATE.OPEN_SENT) {
				transitionSession(session, SESSION_STATE.OFFER_RECEIVED);
				tellSessionNode(session, 'webrtc:offer', { sessionId, sdp, token });
			}
		});

		clientSocket.on('webrtc:candidate', ({ sessionId, candidate } = {}) => {
			const session = sessions.get(sessionId);
			if (session?.clientSocket === clientSocket) {
				tellSessionNode(session, 'webrtc:candidate', { sessionId, candidate });
			}
		});

		clientSocket.on('webrtc:close', ({ sessionId } = {}) => {
			const session = sessions.get(sessionId);
			if (session?.clientSocket === clientSocket) {
				tellSessionNode(session, 'webrtc:close', { sessionId });
				forgetSession(sessionId);
			}
		});

		clientSocket.on('webrtc:session:resume', (...args) => {
			const ack = args.find((arg) => { return typeof arg === 'function'; });
			const sessionId = args.find((arg) => { return arg && typeof arg === 'object'; })?.sessionId;
			if (typeof sessionId !== 'string' || !sessionId) {
				ack?.({ status: 'failed', message: 'sessionId is required.' });
				return;
			}
			const session = sessions.get(sessionId);
			if (session) {
				if (session.nodeId !== nodeId || session.userId !== clientSocket.userId || session.state !== SESSION_STATE.CONNECTED) {
					ack?.({ status: 'failed', message: 'Unknown session.' });
					return;
				}
				reassignSessionClient(session, sessionId, clientSocket);
				refreshOrphanState(session, sessionId);
				ack?.({ status: 'succeeded' });
				return;
			}
			offerResume(sessionId, nodeId, { clientSocket });
			ack?.({ status: 'succeeded' });
		});

		clientSocket.on('disconnect', () => {
			indexRemove(signalSocketsByNodeId, nodeId, clientSocket);
			for (const sessionId of [...(sessionsByClient.get(clientSocket) ?? [])]) {
				const session = sessions.get(sessionId);
				if (session.state !== SESSION_STATE.CONNECTED) {
					tellSessionNode(session, 'webrtc:close', { sessionId });
					forgetSession(sessionId);
					continue;
				}
				refreshOrphanState(session, sessionId);
			}
			for (const [sessionId, pending] of pendingResumes) {
				if (pending.clientSocket === clientSocket) {
					pending.clientSocket = null;
					if (!pending.nodeSocket) {
						dropPendingResume(sessionId);
					}
				}
			}
		});
	});
};

/** A node socket dropped. Sessions still negotiating cannot complete without it, so they end now;
 * an established data channel is browser <-> node and does not need fleet to stay up, so it is
 * kept for a grace period in which the node is expected to reconnect and re-announce it. */
const closeNodeWebrtcSessions = (nodeId, nodeSocket) => {
	for (const sessionId of [...(sessionsByNodeId.get(nodeId) ?? [])]) {
		const session = sessions.get(sessionId);
		if (!session || (nodeSocket && session.nodeSocket !== nodeSocket)) {
			continue;
		}
		if (session.state !== SESSION_STATE.CONNECTED) {
			closeSession(sessionId, { reason: 'node-offline', tellNode: false });
			continue;
		}
		refreshOrphanState(session, sessionId);
	}
	for (const [sessionId, pending] of pendingResumes) {
		if (pending.nodeSocket === nodeSocket) {
			pending.nodeSocket = null;
			if (!pending.clientSocket) {
				dropPendingResume(sessionId);
			}
		}
	}
};

/** A user's access to a node was revoked mid-session (direct revoke, node delete, group un-share,
 * group membership change). Tear down their live WebRTC sessions to that node on both ends — the
 * data channel is direct device control and the node only checks access when the channel opens. */
const closeNodeWebrtcSessionsForUser = (nodeId, userId) => {
	if (userId === null || userId === undefined) {
		return;
	}
	for (const sessionId of [...(sessionsByUserId.get(userId) ?? [])]) {
		const session = sessions.get(sessionId);
		if (session?.nodeId !== nodeId) {
			continue;
		}
		closeSession(sessionId, { reason: 'access-revoked' });
	}
	for (const clientSocket of [...(signalSocketsByNodeId.get(nodeId) ?? [])]) {
		if (clientSocket.userId === userId) {
			clientSocket.disconnect(true);
		}
	}
};

export {
	registerWebrtcSignaling,
	attachNodeWebrtcSignaling,
	closeNodeWebrtcSessions,
	closeNodeWebrtcSessionsForUser
};
