import { randomUUID } from 'crypto';
import { parseFleetNamespace, fleetNamespaceMiddleware } from './fleet_namespace.js';
import { closeNodeWebrtcSessionsForUser } from './webrtc_signal.js';
import { getNodeSocket } from './node_registry.js';
import DataService from '../services/data_service.js';

const CALL_TIMEOUT_MS = 60 * 1000;

const clientsByNodeId = new Map();

function trackClient(nodeId, clientSocket) {
	if (!clientsByNodeId.has(nodeId)) {
		clientsByNodeId.set(nodeId, new Set());
	}
	clientsByNodeId.get(nodeId).add(clientSocket);
}

function untrackClient(nodeId, clientSocket) {
	clientsByNodeId.get(nodeId)?.delete(clientSocket);
}

/** Every proxied client connection is multiplexed over the node's single control socket, keyed by a
 * session id. The dispatcher (attached once per node socket) routes the node's replies back to the
 * originating client. */
function ensureNodeDispatcher(nodeSocket) {
	if (nodeSocket.data.proxySessions) {
		return nodeSocket.data.proxySessions;
	}

	const sessions = new Map();
	const calls = new Map();
	nodeSocket.data.proxySessions = sessions;
	nodeSocket.data.proxyCalls = calls;

	nodeSocket.on('proxy:event', ({ sessionId, event, args } = {}) => {
		const clientSocket = sessions.get(sessionId);
		clientSocket?.emit(event, ...(Array.isArray(args) ? args : []));
	});

	nodeSocket.on('proxy:reply', ({ sessionId, callId, result, error } = {}) => {
		const call = calls.get(callId);
		if (!call || call.sessionId !== sessionId) {
			return;
		}
		calls.delete(callId);
		clearTimeout(call.timer);
		call.ack(error ? { status: 'failed', message: error.message || 'Request failed' } : result);
	});

	nodeSocket.on('proxy:close', ({ sessionId } = {}) => {
		const clientSocket = sessions.get(sessionId);
		if (clientSocket) {
			sessions.delete(sessionId);
			clientSocket.disconnect(true);
		}
	});

	return sessions;
}

function dropSessionCalls(nodeSocket, sessionId) {
	const calls = nodeSocket.data.proxyCalls;
	if (!calls) {
		return;
	}
	for (const [callId, call] of calls) {
		if (call.sessionId === sessionId) {
			clearTimeout(call.timer);
			calls.delete(callId);
		}
	}
}

function bridgeClient(clientSocket, nodeSocket, nodeId, targetNamespace) {
	const sessions = ensureNodeDispatcher(nodeSocket);
	const calls = nodeSocket.data.proxyCalls;
	const sessionId = randomUUID();

	sessions.set(sessionId, clientSocket);
	trackClient(nodeId, clientSocket);
	const user = {
		id: clientSocket.userId,
		email: clientSocket.email,
		groups: ['admins']
	};
	nodeSocket.emit('proxy:open', { sessionId, namespace: targetNamespace, user });

	clientSocket.onAny((event, ...args) => {
		if (!nodeSocket.connected) {
			return;
		}
		const ack = (typeof args[args.length - 1] === 'function') ? args.pop() : null;
		if (!ack) {
			nodeSocket.emit('proxy:event', { sessionId, event, args });
			return;
		}
		const callId = randomUUID();
		const timer = setTimeout(() => {
			calls.delete(callId);
			ack({ status: 'failed', message: 'operation has timed out' });
		}, CALL_TIMEOUT_MS);
		timer.unref?.();
		calls.set(callId, { sessionId, ack, timer });
		nodeSocket.emit('proxy:call', { sessionId, callId, event, args });
	});

	clientSocket.on('disconnect', () => {
		sessions.delete(sessionId);
		dropSessionCalls(nodeSocket, sessionId);
		untrackClient(nodeId, clientSocket);
		if (nodeSocket.connected) {
			nodeSocket.emit('proxy:close', { sessionId });
		}
	});
}

/** Registers fleet node proxy namespaces on the main Socket.IO server. Clients connect to
 * `/fleet/{nodeId}/{module}` on path `/api` instead of separate Server instances per node. */
function registerFleetProxy(io) {
	const fleetNsp = io.of(/^\/fleet\/[^/]+\/.+$/);

	fleetNsp.use(fleetNamespaceMiddleware);

	fleetNsp.on('connection', (clientSocket) => {
		const parsed = parseFleetNamespace(clientSocket.nsp.name);
		if (!parsed) {
			clientSocket.disconnect(true);
			return;
		}
		const nodeSocket = getNodeSocket(parsed.nodeId);
		if (!nodeSocket?.connected) {
			clientSocket.disconnect(true);
			return;
		}
		bridgeClient(clientSocket, nodeSocket, parsed.nodeId, parsed.targetNamespace);
	});
}

function disconnectNodeClients(nodeId) {
	const clients = clientsByNodeId.get(nodeId);
	if (!clients) {
		return;
	}
	for (const clientSocket of [...clients]) {
		clientSocket.disconnect(true);
	}
	clientsByNodeId.delete(nodeId);
}

/** Drops a single user's live proxy sessions for a node (e.g. after their access is revoked),
 * so an already-bridged session is torn down immediately instead of surviving until reconnect.
 * Their WebRTC data channel to the node (which the node only access-checks at open time) is torn
 * down on the same terms. */
function disconnectNodeUser(nodeId, userId) {
	if (!userId) {
		return;
	}
	for (const clientSocket of [...(clientsByNodeId.get(nodeId) ?? [])]) {
		if (clientSocket.userId === userId) {
			clientSocket.disconnect(true);
		}
	}
	closeNodeWebrtcSessionsForUser(nodeId, userId);
}

/** Enforces access after a group membership/share change (removal, group deletion). For each of the
 * given users, re-evaluates access to each node and tears down any live proxy session to a node they
 * can no longer reach. Access is otherwise only checked at namespace-connect, so without this a
 * revoked user keeps an open session — and full device control — until they happen to disconnect.
 * Users who still hold another path (a direct grant or another group) keep their sessions. Must be
 * called AFTER the DB change so the re-check reflects the new state. */
async function revokeStaleNodeAccess(userIds, nodeIds) {
	if (!userIds.length || !nodeIds.length) {
		return;
	}
	for (const userId of userIds) {
		const stillAccessible = new Set(
			(await DataService.listAccessibleNodes(userId)).map((node) => { return node.nodeId; })
		);
		for (const nodeId of nodeIds) {
			if (!stillAccessible.has(nodeId)) {
				disconnectNodeUser(nodeId, userId);
			}
		}
	}
}

export {
	registerFleetProxy,
	disconnectNodeClients,
	disconnectNodeUser,
	revokeStaleNodeAccess
};
