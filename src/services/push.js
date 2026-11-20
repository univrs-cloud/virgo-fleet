import dns from 'dns';
import https from 'https';
import net from 'net';
import * as webpush from 'web-push';
import DataService from './data_service.js';

const PRIVATE_ADDRESSES = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^::$/,
	/^::1$/,
	/^f[cd]/i,
	/^fe80:/i
];

const isPrivateAddress = (address) => {
	const normalized = String(address || '').replace(/^::ffff:/i, '').toLowerCase();
	return PRIVATE_ADDRESSES.some((pattern) => { return pattern.test(normalized); });
};

const publicLookup = (hostname, options, callback) => {
	dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) {
			callback(error);
			return;
		}
		if (addresses.some((entry) => { return isPrivateAddress(entry.address); })) {
			callback(Object.assign(new Error(`${hostname} is on a private network.`), { code: 'EPRIVATE' }));
			return;
		}
		if (options?.all) {
			callback(null, addresses);
			return;
		}
		callback(null, addresses[0].address, addresses[0].family);
	});
};

const publicAgent = new https.Agent({ lookup: publicLookup });

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
		const host = new URL(sub.endpoint).hostname.replace(/^\[|\]$/g, '');
		if (net.isIP(host) && isPrivateAddress(host)) {
			console.error(`[push] Refused to send a notification to ${host}, it is on a private network.`);
			return;
		}
		try {
			await webpush.sendNotification(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				payload,
				{ agent: publicAgent }
			);
		} catch (error) {
			// 404/410 mean the browser has dropped this subscription; prune it so we stop trying.
			if (error?.statusCode === 404 || error?.statusCode === 410) {
				try {
					await DataService.deletePushSubscription(sub.endpoint);
				} catch { }
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

	static #describeStorageChanges(changes) {
		const describe = (change) => {
			if (change.to === 'online') {
				return `${change.pool} recovered`;
			}
			if (change.to === 'rebuilding') {
				return `${change.pool} is rebuilding`;
			}
			return `${change.pool} is ${change.to}`;
		};
		return `Storage: ${changes.map(describe).join(', ')}.`;
	}

	/** Fan a "a pool's health changed" notification out to every push subscription of the given users.
	 * `changes` is a list of { pool, from, to } state transitions. */
	static async sendNodeStorageNotification(userIds, { nodeId, name, changes }) {
		if (!this.#configured || !userIds?.length || !changes?.length) {
			return;
		}
		const subs = await DataService.listPushSubscriptionsForUsers(userIds);
		if (!subs.length) {
			return;
		}
		const payload = JSON.stringify({
			type: 'node-storage',
			nodeId,
			title: name || 'A node',
			body: this.#describeStorageChanges(changes)
		});
		await Promise.all(subs.map((sub) => { return this.#sendToSubscription(sub, payload); }));
	}
}

export default PushService;
