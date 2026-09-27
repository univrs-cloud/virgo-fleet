import DataService from '../services/data_service.js';
import {
	clearAuthCookies,
	getSessionTokenFromCookieHeader,
	setAuthCookies
} from '../utils/auth_cookies.js';

/**
 * Sets the account cookie from a valid virgo.session cookie issued by fleet login. Fleet is
 * internet-facing with no Authelia in front, so no request header (Remote-User etc.) is trusted —
 * the signed session cookie is the only identity source.
 */
export default async (req, res, next) => {
	const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie);
	if (sessionToken) {
		try {
			const session = await DataService.getSessionByToken(sessionToken);
			if (session?.User) {
				// Not awaited: the write is throttled server-side and no response should wait on it.
				DataService.touchSession(sessionToken).catch((error) => {
					console.error('Failed to record fleet session activity:', error);
				});
				// Carry the session's MFA state onto the refreshed cookie — otherwise this per-request
				// re-issue defaults to 'satisfied' and strips the mfa flag that login/verify set, so the
				// UI would route a gated session into the app instead of the setup/challenge screen.
				setAuthCookies(res, req, {
					token: sessionToken,
					user: session.User,
					mfaState: session.mfaState
				});
				next();
				return;
			}
		} catch (error) {
			console.error('Failed to resolve fleet session cookie:', error);
		}
	}

	clearAuthCookies(res, req);
	next();
};
