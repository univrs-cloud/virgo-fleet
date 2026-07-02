import { Server } from 'socket.io';

let io = null;
let httpServer = null;

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}

	httpServer = server;
	io = new Server(server, {
		path: '/api',
		cors: {
			origin: true,
			credentials: true
		}
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
