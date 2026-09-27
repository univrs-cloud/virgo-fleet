import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader } from './auth_cookies.js';
import * as sessionSockets from './session_sockets.js';

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
	sessionSockets.track(socket, session.id, session.expiresAt);
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
