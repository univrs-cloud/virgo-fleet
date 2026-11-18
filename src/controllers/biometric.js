import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';
import { getRequestClientContext } from '../utils/client_context.js';

async function resolveSession(req) {
	const token = getSessionTokenFromCookieHeader(req.headers.cookie);
	const session = token ? await DataService.getSessionByToken(token) : null;
	if (!session?.User || session.mfaState !== 'satisfied') {
		return null;
	}
	return session;
}

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
		const { challenge, challengeId } = await DataService.beginBiometricRegistration(session.User.id);
		res.json({ status: 'succeeded', challenge, challengeId });
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
		await DataService.completeBiometricRegistration({
			userId: user.id,
			challengeId: req.body?.challengeId,
			credentialId: req.body?.credentialId,
			publicKey: req.body?.publicKey,
			signature: req.body?.signature
		});
		user.biometricEnabled = true;
		refreshAccountCookie(res, req, session);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

async function authenticateOptions(req, res) {
	try {
		const { challenge, challengeId } = await DataService.beginBiometricAuthentication();
		res.json({ status: 'succeeded', challenge, challengeId });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

async function authenticateVerify(req, res) {
	try {
		const result = await DataService.completeBiometricAuthentication({
			challengeId: req.body?.challengeId,
			credentialId: req.body?.credentialId,
			signature: req.body?.signature,
			context: getRequestClientContext(req)
		});
		setAuthCookies(res, req, { token: result.token, user: result.user, mfaState: 'satisfied' });
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(401).json({ status: 'failed', message: error.message });
	}
}

async function disable(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const user = session.User;
		await DataService.disableBiometrics(user.id);
		user.biometricEnabled = false;
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
