import DataService from '../services/data_service.js';
import PushService from '../services/push.js';
import { getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';

// Only a fully authenticated (MFA-satisfied) session may manage its push subscriptions.
async function resolveSession(req) {
	const token = getSessionTokenFromCookieHeader(req.headers.cookie);
	const session = token ? await DataService.getSessionByToken(token) : null;
	if (!session?.FleetUser || session.mfaState !== 'satisfied') {
		return null;
	}
	return session;
}

// Re-issue the account cookie so the just-changed pushEnabled flag reaches the UI in the same
// response (the authCookieHandler ran earlier in the request, before the change).
function refreshAccountCookie(res, req, session) {
	setAuthCookies(res, req, { token: session.token, user: session.FleetUser, mfaState: session.mfaState });
}

// The VAPID public key the client passes to PushManager.subscribe(). Not secret; 503 when push
// isn't configured so the client can skip subscribing.
function getVapidKey(req, res) {
	const publicKey = PushService.getVapidPublicKey();
	if (!publicKey) {
		res.status(503).json({ status: 'failed', message: 'Push notifications are not configured.' });
		return;
	}
	res.json({ status: 'succeeded', publicKey });
}

// Turn notifications on: register this device's subscription (serialized PushSubscription in the
// body — { endpoint, keys: { p256dh, auth } }) and set the account-level preference.
async function enable(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const user = session.FleetUser;
		await DataService.savePushSubscription(user.id, req.body);
		await DataService.setUserPushEnabled(user.id, true);
		user.pushEnabled = true;
		refreshAccountCookie(res, req, session);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Turn notifications off for the whole account: clear the preference and drop every device's
// subscription so nothing is delivered anywhere.
async function disable(req, res) {
	try {
		const session = await resolveSession(req);
		if (!session) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const user = session.FleetUser;
		await DataService.setUserPushEnabled(user.id, false);
		await DataService.deletePushSubscriptionsForUser(user.id);
		user.pushEnabled = false;
		refreshAccountCookie(res, req, session);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

export {
	getVapidKey,
	enable,
	disable
};
