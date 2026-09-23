import { Server } from 'socket.io';
import * as trustedProxy from './utils/trusted_proxy.js';

let io = null;

const isSameOrigin = (request) => {
	const origin = request?.headers?.origin;
	if (!origin) {
		return true;
	}

	const forwarded = (trustedProxy.isFromTrustedProxy(request.socket?.remoteAddress) ? request.headers['x-forwarded-host'] : undefined);
	const host = (forwarded || request.headers.host || '').split(',')[0].trim();
	if (!host) {
		return false;
	}

	try {
		return new URL(origin).host === host;
	} catch (error) {
		return false;
	}
};

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}
	
	io = new Server(server, {
		path: '/api',
		maxHttpBufferSize: 4 * 1024 * 1024,
		allowRequest: (request, callback) => { callback(null, isSameOrigin(request)); }
	});

	return io;
};

const getIO = () => {
	if (!io) {
		throw new Error('Socket.IO not initialized. Call initializeSocket first.');
	}
	return io;
};

export {
	initializeSocket,
	getIO
};
