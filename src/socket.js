import { Server } from 'socket.io';

let io = null;

const initializeSocket = (server) => {
	if (io) {
		throw new Error('Socket.IO already initialized');
	}
	
	io = new Server(server, {
		path: '/api',
		maxHttpBufferSize: 4 * 1024 * 1024,
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

export {
	initializeSocket,
	getIO
};
