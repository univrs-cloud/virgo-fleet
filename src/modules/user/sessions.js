import DataService from '../../services/data_service.js';
import { getSessionTokenFromCookieHeader } from '../../utils/auth_cookies.js';
import * as sessionSockets from '../../utils/session_sockets.js';

/** Self-service like the rest of `/user`: every query is scoped by the socket's own userId, so an
 * id from another account matches nothing, and the session token never leaves the server. */
const emitSessions = async (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}
	try {
		const sessions = await DataService.listSessions(socket.userId);
		socket.emit('user:sessions', sessions.map((session) => {
			return { ...session, current: session.id === socket.sessionId };
		}));
	} catch (error) {
		console.error('Error emitting sessions:', error);
	}
};

const broadcastSessions = async (module, userId) => {
	const sockets = [...module.nsp.sockets.values()].filter((socket) => {
		return socket.userId === userId;
	});
	await Promise.all(sockets.map((socket) => { return emitSessions(socket); }));
};

const revokeSession = async (config, socket) => {
	const sessionId = await DataService.revokeSession(socket.userId, config?.id);
	// Deleting the row only stops the next sign-in; this drops what that session already holds open,
	// across the fleet namespaces and any proxied node ones.
	sessionSockets.disconnectSessions([sessionId]);
};

// Everything but the session making the request — the lost-device switch. Unlike a password change,
// which ends every session, this one keeps the caller signed in.
const revokeOtherSessions = async (socket) => {
	const currentToken = getSessionTokenFromCookieHeader(socket.handshake?.headers?.cookie);
	const sessionIds = await DataService.revokeOtherSessions(socket.userId, currentToken);
	sessionSockets.disconnectSessions(sessionIds);
	return sessionIds.length;
};

const register = (module) => {
	module.eventEmitter.on('sessions:updated', (payload) => {
		broadcastSessions(module, payload?.userId).catch((error) => {
			console.error('Error broadcasting sessions:', error);
		});
	});
};

const onConnection = (socket, module) => {
	socket.on('user:sessions:list', async (_config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			await emitSessions(socket);
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('user:sessions:revoke', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			await revokeSession(config, socket);
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('user:sessions:revoke-others', async (_config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const count = await revokeOtherSessions(socket);
			ack({ status: 'succeeded', count });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	emitSessions(socket);
};

export default {
	name: 'sessions',
	onConnection,
	register
};
