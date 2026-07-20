import DataService from '../services/data_service.js';
import PushService from '../services/push.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';

// Only a fully authenticated (MFA-satisfied) session may manage its push subscriptions.
async function resolveUser(req) {
	const token = getSessionTokenFromCookieHeader(req.headers.cookie);
	const session = token ? await DataService.getSessionByToken(token) : null;
	if (!session?.FleetUser || session.mfaState !== 'satisfied') {
		return null;
	}
	return session.FleetUser;
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

// Body is the serialized PushSubscription ({ endpoint, keys: { p256dh, auth } }).
async function subscribe(req, res) {
	try {
		const user = await resolveUser(req);
		if (!user) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		await DataService.savePushSubscription(user.id, req.body);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Body is { endpoint }. Idempotent — unsubscribing an unknown endpoint still succeeds.
async function unsubscribe(req, res) {
	try {
		const user = await resolveUser(req);
		if (!user) {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		await DataService.deletePushSubscription(req.body?.endpoint);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

export {
	getVapidKey,
	subscribe,
	unsubscribe
};
