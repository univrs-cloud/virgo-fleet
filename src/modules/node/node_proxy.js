import { Server } from 'socket.io';
import { getHttpServer } from '../../socket.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';
import DataService from '../../database/data_service.js';

const nodeProxies = new Map();

function attachBridge(clientSocket, nodeSocket) {
	const forwardToNode = (event, ...args) => {
		nodeSocket.emit(event, ...args);
	};
	const forwardToClient = (event, ...args) => {
		clientSocket.emit(event, ...args);
	};

	clientSocket.onAny(forwardToNode);
	nodeSocket.onAny(forwardToClient);

	clientSocket.on('disconnect', () => {
		nodeSocket.offAny(forwardToClient);
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

	const hostNsp = proxyIo.of('/host');
	hostNsp.use(async (socket, next) => {
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
	hostNsp.on('connection', (clientSocket) => {
		const nodeSocket = getNodeSocket(nodeId);
		if (!nodeSocket) {
			clientSocket.disconnect(true);
			return;
		}
		attachBridge(clientSocket, nodeSocket);
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
