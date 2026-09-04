import { randomUUID } from 'crypto';
import { authenticateSocketUser } from './socket_auth.js';
import { createRateLimiter, getSocketClientAddress } from './socket_rate_limit.js';
import { iceServers } from './turn.js';
import { mintNodeSessionToken } from './node_authz_token.js';
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

const sessionRequestLimiter = createRateLimiter({ windowMs: SESSION_REQUEST_WINDOW_MS, max: 60 });

// sessionId -> { clientSocket, nodeSocket, nodeId, userId }
const sessions = new Map();
// nodeId -> Set<sessionId>, userId -> Set<sessionId>: reverse indexes for the teardown hooks.
const sessionsByNodeId = new Map();
const sessionsByUserId = new Map();
const signalSocketsByNodeId = new Map();

let getNodeSocket = () => {
	return null;
};

const registerNodeSocketGetter = (getter) => {
	getNodeSocket = getter;
};

const parseSignalNamespace = (name) => {
	const parts = name.split('/');
	if (parts.length !== 4 || parts[1] !== 'fleet' || parts[3] !== 'signal') {
		return null;
	}
	return { nodeId: parts[2] };
};

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
	sessions.delete(sessionId);
	indexRemove(sessionsByNodeId, session.nodeId, sessionId);
	indexRemove(sessionsByUserId, session.userId, sessionId);
};

const countSessionsForClient = (clientSocket) => {
	let count = 0;
	for (const session of sessions.values()) {
		if (session.clientSocket === clientSocket) {
			count += 1;
		}
	}
	return count;
};

const tellSessionNode = (session, event, payload) => {
	if (session?.nodeSocket?.connected) {
		session.nodeSocket.emit(event, payload);
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

	sessions.set(sessionId, { clientSocket, nodeSocket, nodeId, userId: clientSocket.userId });
	indexAdd(sessionsByNodeId, nodeId, sessionId);
	indexAdd(sessionsByUserId, clientSocket.userId, sessionId);

	nodeSocket.emit('webrtc:open', { sessionId, token, iceServers: servers });
	ack({ status: 'succeeded', sessionId, iceServers: servers, token });
};

/** Registers the `/fleet/{nodeId}/signal` namespace. Must run before registerFleetProxy so the
 * `/signal` suffix is matched here and not swallowed by the generic proxy matcher. */
const registerWebrtcSignaling = (io, nodeSocketGetter) => {
	registerNodeSocketGetter(nodeSocketGetter);

	const signalNsp = io.of(SIGNAL_NAMESPACE_PATTERN);

	signalNsp.use(async (socket, next) => {
		const parsed = parseSignalNamespace(socket.nsp.name);
		if (!parsed) {
			next(new Error('Invalid signaling namespace'));
			return;
		}
		try {
			await authenticateSocketUser(socket);
			if (!socket.isAuthenticated) {
				next(new Error('Authentication required'));
				return;
			}
			if (!(await DataService.canUserAccessNode(socket.userId, parsed.nodeId))) {
				next(new Error('Access denied for node'));
				return;
			}
			socket.data.nodeId = parsed.nodeId;
			next();
		} catch (error) {
			next(error);
		}
	});

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
			if (session?.clientSocket === clientSocket) {
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

		clientSocket.on('disconnect', () => {
			indexRemove(signalSocketsByNodeId, nodeId, clientSocket);
			for (const [sessionId, session] of sessions) {
				if (session.clientSocket === clientSocket) {
					tellSessionNode(session, 'webrtc:close', { sessionId });
					forgetSession(sessionId);
				}
			}
		});
	});
};

/** A node socket dropped: every WebRTC session opened on it is dead. Tell each browser so it falls
 * back to the Socket.IO proxy; the node itself is gone so there is nothing to notify. */
const closeNodeWebrtcSessions = (nodeId, nodeSocket) => {
	for (const sessionId of [...(sessionsByNodeId.get(nodeId) ?? [])]) {
		const session = sessions.get(sessionId);
		if (!session || (nodeSocket && session.nodeSocket !== nodeSocket)) {
			continue;
		}
		session.clientSocket.emit('webrtc:close', { sessionId, reason: 'node-offline' });
		forgetSession(sessionId);
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
		tellSessionNode(session, 'webrtc:close', { sessionId });
		session.clientSocket.emit('webrtc:close', { sessionId, reason: 'access-revoked' });
		forgetSession(sessionId);
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
