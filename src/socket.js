import { Server } from 'socket.io';
import config from '../config.js';

let io = null;
let httpServer = null;

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}

	httpServer = server;
	io = new Server(server, {
		path: config.fleet.socketPath,
		cors: {
			origin: true,
			credentials: true
		}
	});

	io.of('/runtime').on('connection', (socket) => {
		socket.emit('runtime', { role: 'fleet' });
	});

	return io;
};

const getIO = () => {
	if (!io) {
		throw new Error('Socket.IO not initialized. Call initializeSocket first.');
	}
	return io;
};

const getHttpServer = () => {
	if (!httpServer) {
		throw new Error('HTTP server not initialized. Call initializeSocket first.');
	}
	return httpServer;
};

export {
	initializeSocket,
	getIO,
	getHttpServer
};
