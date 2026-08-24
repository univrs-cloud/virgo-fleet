import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';
import { getRequestClientContext } from '../utils/client_context.js';

// Enrolling and revoking are account settings, so they need a fully authenticated session — the
// same bar as managing push subscriptions. The two sign-in endpoints below deliberately do not.
async function resolveSession(req) {
	const token = getSessionTokenFromCookieHeader(req.headers.cookie);
	const session = token ? await DataService.getSessionByToken(token) : null;
	if (!session?.User || session.mfaState !== 'satisfied') {
		return null;
	}
	return session;
}

// Re-issue the account cookie so the just-changed passkeyEnabled flag reaches the UI in the same
// response (authCookieHandler ran earlier in the request, before the change).
function refreshAccountCookie(res, req, session) {
	setAuthCookies(res, req, { token: session.token, user: session.User, mfaState: session.mfaState });
}

async function registerOptions(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const { options, challengeId } = await DataService.beginPasskeyRegistration(session.User.id);
		res.json({ status: 'succeeded', options, challengeId });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

async function registerVerify(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const user = session.User;
		await DataService.completePasskeyRegistration({
			userId: user.id,
			challengeId: req.body?.challengeId,
			response: req.body?.response
		});
		user.passkeyEnabled = true;
		refreshAccountCookie(res, req, session);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Unauthenticated: this is the start of a sign-in. The response carries no account information —
// it's a bare challenge, and which account it ends up proving is decided by the authenticator.
async function authenticateOptions(req, res) {
	try {
		const { options, challengeId } = await DataService.beginPasskeyAuthentication();
		res.json({ status: 'succeeded', options, challengeId });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Unauthenticated. On success the session is minted already satisfied, so the UI lands straight on
// the app without a TOTP challenge.
async function authenticateVerify(req, res) {
	try {
		const result = await DataService.completePasskeyAuthentication({
			challengeId: req.body?.challengeId,
			response: req.body?.response,
			context: getRequestClientContext(req)
		});
		setAuthCookies(res, req, { token: result.token, user: result.user, mfaState: 'satisfied' });
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(401).json({ status: 'failed', message: error.message });
	}
}

// Account-wide revoke: drops every enrolled device. The current session stays valid — the user is
// turning off a sign-in method, not signing out.
async function disable(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const user = session.User;
		await DataService.disablePasskeys(user.id);
		user.passkeyEnabled = false;
		refreshAccountCookie(res, req, session);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

export {
	registerOptions,
	registerVerify,
	authenticateOptions,
	authenticateVerify,
	disable
};
