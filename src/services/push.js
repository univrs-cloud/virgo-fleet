import webpush from 'web-push';
import DataService from './data_service.js';

// VAPID keypair is provided via the environment (see Dockerfile / README) and generated once — the
// public key is baked into every browser subscription, so rotating it invalidates them all. When the
// keys are absent, push is left disabled and every send is a no-op rather than a boot failure.
class PushService {
	static #configured = false;
	static #publicKey = null;

	static initialize() {
		const pub = process.env.VAPID_PUBLIC_KEY;
		const priv = process.env.VAPID_PRIVATE_KEY;
		const subject = process.env.VAPID_SUBJECT;
		if (!pub || !priv || !subject) {
			console.warn('[push] VAPID keys not configured; update notifications are disabled.');
			return;
		}
		webpush.setVapidDetails(subject, pub, priv);
		this.#publicKey = pub;
		this.#configured = true;
	}

	static isConfigured() {
		return this.#configured;
	}

	static getVapidPublicKey() {
		return this.#publicKey;
	}

	static #describeUpdates(systemCount, appsCount) {
		const parts = [];
		if (systemCount > 0) {
			parts.push(`${systemCount} system update${systemCount === 1 ? '' : 's'}`);
		}
		if (appsCount > 0) {
			parts.push(`${appsCount} app update${appsCount === 1 ? '' : 's'}`);
		}
		return parts.join(' and ');
	}

	static async #sendToSubscription(sub, payload) {
		try {
			await webpush.sendNotification(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				payload
			);
		} catch (error) {
			// 404/410 mean the browser has dropped this subscription; prune it so we stop trying.
			if (error?.statusCode === 404 || error?.statusCode === 410) {
				await DataService.deletePushSubscription(sub.endpoint).catch(() => {});
				return;
			}
			console.error('[push] Failed to send notification:', error?.statusCode || error?.message || error);
		}
	}

	/** Fan a "node has updates available" notification out to every push subscription of the given users. */
	static async sendNodeUpdateNotification(userIds, { nodeId, name, systemCount, appsCount }) {
		if (!this.#configured || !userIds?.length) {
			return;
		}
		const subs = await DataService.listPushSubscriptionsForUsers(userIds);
		if (!subs.length) {
			return;
		}
		const payload = JSON.stringify({
			type: 'node-updates',
			nodeId,
			title: name || 'A node',
			body: `${this.#describeUpdates(systemCount, appsCount)} available.`
		});
		await Promise.all(subs.map((sub) => { return this.#sendToSubscription(sub, payload); }));
	}
}

export default PushService;
