import * as trustedProxy from '../utils/trusted_proxy.js';
import DataService from '../database/data_service.js';
import {
	buildAccountFromUser,
	clearAuthCookies,
	getCookieOptions,
	getSessionTokenFromCookieHeader,
	serializeAccount,
	setAuthCookies
} from '../utils/auth_cookies.js';

/**
 * Sets the account cookie so the UI matches virgo-api / Authelia shape.
 * Trusted-proxy headers (Traefik + Authelia) take precedence; otherwise a
 * valid virgo.session cookie from fleet login is used.
 */
export default async (req, res, next) => {
	const cookieOptions = getCookieOptions(req);

	if (trustedProxy.isFromTrustedProxy(req.socket?.remoteAddress) && req.headers['remote-user']) {
		const account = {
			name: req.headers['remote-name'],
			user: req.headers['remote-user'],
			email: req.headers['remote-email'],
			groups: req.headers['remote-groups']?.split(',')
		};
		res.cookie('account', serializeAccount(account), cookieOptions);
		res.header('Access-Control-Allow-Origin', '*');
		next();
		return;
	}

	const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie);
	if (sessionToken) {
		try {
			const session = await DataService.getSessionByToken(sessionToken);
			if (session?.FleetUser) {
				setAuthCookies(res, req, {
					token: sessionToken,
					user: session.FleetUser
				});
				res.header('Access-Control-Allow-Origin', '*');
				next();
				return;
			}
		} catch (error) {
			console.error('Failed to resolve fleet session cookie:', error);
		}
	}

	clearAuthCookies(res, req);
	res.header('Access-Control-Allow-Origin', '*');
	next();
};
