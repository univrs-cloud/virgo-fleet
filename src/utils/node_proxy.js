import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { getHttpServer } from '../socket.js';
import { authenticateSocketUser } from './socket_auth.js';
import DataService from '../database/data_service.js';

const nodeProxies = new Map();

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

function bridgeClient(clientSocket, nodeSocket) {
	const sessions = ensureNodeDispatcher(nodeSocket);
	const sessionId = randomUUID();
	const namespace = clientSocket.nsp.name;

	sessions.set(sessionId, clientSocket);
	nodeSocket.emit('proxy:open', { sessionId, namespace });

	clientSocket.onAny((event, ...args) => {
		if (nodeSocket.connected) {
			nodeSocket.emit('proxy:event', { sessionId, event, args });
		}
	});

	clientSocket.on('disconnect', () => {
		sessions.delete(sessionId);
		if (nodeSocket.connected) {
			nodeSocket.emit('proxy:close', { sessionId });
		}
	});
}

function ensureNodeProxy(nodeId, getNodeSocket) {
	if (nodeProxies.has(nodeId)) {
		return nodeProxies.get(nodeId);
	}

	const httpServer = getHttpServer();
	const proxyIo = new Server(httpServer, {
		path: `/api/fleet/${nodeId}`,
		cors: {
			origin: true,
			credentials: true
		}
	});

	// Match any namespace: the fleet is a dumb relay, the node decides what each namespace does.
	const proxyNamespaces = proxyIo.of(/.*/);

	proxyNamespaces.use(async (socket, next) => {
		try {
			await authenticateSocketUser(socket);
			if (!socket.isAuthenticated) {
				next(new Error('Authentication required'));
				return;
			}
			const allowed = await DataService.canUserAccessNode(socket.userId, nodeId);
			if (!allowed) {
				next(new Error('Access denied for node'));
				return;
			}
			next();
		} catch (error) {
			next(error);
		}
	});

	proxyNamespaces.on('connection', (clientSocket) => {
		const nodeSocket = getNodeSocket(nodeId);
		if (!nodeSocket) {
			clientSocket.disconnect(true);
			return;
		}
		bridgeClient(clientSocket, nodeSocket);
	});

	nodeProxies.set(nodeId, proxyIo);
	return proxyIo;
}

function removeNodeProxy(nodeId) {
	const proxy = nodeProxies.get(nodeId);
	if (!proxy) {
		return;
	}
	proxy.close();
	nodeProxies.delete(nodeId);
}

export {
	ensureNodeProxy,
	removeNodeProxy
};
