import { randomUUID } from 'crypto';
import { authenticateSocketUser } from './socket_auth.js';
import DataService from '../database/data_service.js';

const clientsByNodeId = new Map();

function parseFleetNamespace(name) {
	const parts = name.split('/');
	if (parts.length < 4 || parts[1] !== 'fleet') {
		return null;
	}
	return {
		nodeId: parts[2],
		targetNamespace: `/${parts.slice(3).join('/')}`
	};
}

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
	nodeSocket.data.proxySessions = sessions;

	nodeSocket.on('proxy:event', ({ sessionId, event, args } = {}) => {
		const clientSocket = sessions.get(sessionId);
		clientSocket?.emit(event, ...(Array.isArray(args) ? args : []));
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

function bridgeClient(clientSocket, nodeSocket, nodeId, targetNamespace) {
	const sessions = ensureNodeDispatcher(nodeSocket);
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
		if (nodeSocket.connected) {
			nodeSocket.emit('proxy:event', { sessionId, event, args });
		}
	});

	clientSocket.on('disconnect', () => {
		sessions.delete(sessionId);
		untrackClient(nodeId, clientSocket);
		if (nodeSocket.connected) {
			nodeSocket.emit('proxy:close', { sessionId });
		}
	});
}

/** Registers fleet node proxy namespaces on the main Socket.IO server. Clients connect to
 * `/fleet/{nodeId}/{module}` on path `/api` instead of separate Server instances per node. */
function registerFleetProxy(io, getNodeSocket) {
	const fleetNsp = io.of(/^\/fleet\/[^/]+\/.+$/);

	fleetNsp.use(async (socket, next) => {
		const parsed = parseFleetNamespace(socket.nsp.name);
		if (!parsed) {
			next(new Error('Invalid fleet namespace'));
			return;
		}
		try {
			await authenticateSocketUser(socket);
			if (!socket.isAuthenticated) {
				next(new Error('Authentication required'));
				return;
			}
			const allowed = await DataService.canUserAccessNode(socket.userId, parsed.nodeId);
			if (!allowed) {
				next(new Error('Access denied for node'));
				return;
			}
			next();
		} catch (error) {
			next(error);
		}
	});

	fleetNsp.on('connection', (clientSocket) => {
		const parsed = parseFleetNamespace(clientSocket.nsp.name);
		if (!parsed) {
			clientSocket.disconnect(true);
			return;
		}
		const nodeSocket = getNodeSocket(parsed.nodeId);
		if (!nodeSocket) {
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
 * so an already-bridged session is torn down immediately instead of surviving until reconnect. */
function disconnectNodeUser(nodeId, userId) {
	if (!userId) {
		return;
	}
	for (const clientSocket of [...(clientsByNodeId.get(nodeId) ?? [])]) {
		if (clientSocket.userId === userId) {
			clientSocket.disconnect(true);
		}
	}
}

export {
	registerFleetProxy,
	disconnectNodeClients,
	disconnectNodeUser
};
