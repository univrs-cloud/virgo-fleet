import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader } from './auth_cookies.js';
import * as sessionSockets from './session_sockets.js';
import * as trustedProxy from './trusted_proxy.js';

async function applyFleetUserSession(socket, sessionToken) {
	if (!sessionToken) {
		return false;
	}
	const session = await DataService.getSessionByToken(sessionToken);
	// A session that hasn't cleared MFA (setup_required / challenge_required) is not authenticated
	// for anything on the socket — only the HTTP MFA endpoints can act on it.
	if (!session?.User || session.mfaState !== 'satisfied') {
		return false;
	}
	socket.isAuthenticated = true;
	socket.email = session.User.email;
	socket.userId = session.User.id;
	// Bound here because every namespace authenticates through this function; revoking a session
	// then drops its live connections instead of waiting for them to reconnect.
	sessionSockets.track(socket, session.id);
	DataService.touchSession(sessionToken).catch((error) => {
		console.error('Failed to record fleet session activity:', error);
	});
	return true;
}

async function authenticateSocketUser(socket) {
	const sessionToken = getSessionTokenFromCookieHeader(socket.handshake?.headers?.cookie);
	if (await applyFleetUserSession(socket, sessionToken)) {
		return true;
	}

	const remoteUser = (trustedProxy.isFromTrustedProxy(socket.conn?.remoteAddress) ? socket.handshake.headers['remote-user'] : undefined);
	if (remoteUser) {
		const user = await DataService.getUserByEmail(remoteUser);
		socket.isAuthenticated = true;
		socket.email = user?.email || remoteUser;
		socket.userId = user?.id || null;
		return true;
	}

	socket.isAuthenticated = false;
	socket.email = 'guest';
	socket.userId = null;
	return false;
}

export {
	applyFleetUserSession,
	authenticateSocketUser,
	getSessionTokenFromCookieHeader
};
