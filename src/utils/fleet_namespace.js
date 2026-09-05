import { authenticateSocketUser } from './socket_auth.js';
import DataService from '../services/data_service.js';

const parseFleetNamespace = (name) => {
	const parts = String(name || '').split('/');
	if (parts.length < 4 || parts[1] !== 'fleet' || !parts[2]) {
		return null;
	}
	return {
		nodeId: parts[2],
		targetNamespace: `/${parts.slice(3).join('/')}`
	};
};

const fleetNamespaceMiddleware = async (socket, next) => {
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
		if (!(await DataService.canUserAccessNode(socket.userId, parsed.nodeId))) {
			next(new Error('Access denied for node'));
			return;
		}
		socket.data.nodeId = parsed.nodeId;
		socket.data.targetNamespace = parsed.targetNamespace;
		next();
	} catch (error) {
		next(error);
	}
};

export {
	parseFleetNamespace,
	fleetNamespaceMiddleware
};
