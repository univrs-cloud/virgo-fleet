import DataService from '../database/data_service.js';
import { getSessionTokenFromCookieHeader } from './auth_cookies.js';
import * as trustedProxy from './trusted_proxy.js';

async function applyFleetUserSession(socket, sessionToken) {
	if (!sessionToken) {
		return false;
	}
	const session = await DataService.getSessionByToken(sessionToken);
	if (!session?.FleetUser) {
		return false;
	}
	socket.isAuthenticated = true;
	socket.email = session.FleetUser.email;
	socket.userId = session.FleetUser.id;
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
