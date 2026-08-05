import * as trustedProxy from './trusted_proxy.js';

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fixed-window attempt counters for socket events. express-rate-limit only covers HTTP middleware,
 * so socket handlers that act on unauthenticated input need their own. State is per process — the
 * fleet runs as a single instance, so there is no shared store to coordinate with.
 */
function createRateLimiter({ windowMs, max }) {
	const buckets = new Map();
	// Expired buckets are also replaced on their next consume(); this sweep is what keeps keys that
	// are never seen again (a one-off IP) from accumulating. Unref'd so it never holds the process up.
	setInterval(() => {
		const now = Date.now();
		for (const [key, bucket] of buckets) {
			if (bucket.expiresAt <= now) {
				buckets.delete(key);
			}
		}
	}, PRUNE_INTERVAL_MS).unref();

	return {
		/** Records an attempt against `key`, returning false once the window's allowance is spent. */
		consume(key) {
			const now = Date.now();
			const bucket = buckets.get(key);
			if (!bucket || bucket.expiresAt <= now) {
				buckets.set(String(key), { count: 1, expiresAt: now + windowMs });
				return true;
			}
			bucket.count += 1;
			return bucket.count <= max;
		}
	};
}

/**
 * The client address to key a limiter on: the first X-Forwarded-For entry when the TCP peer is a
 * trusted proxy, the peer address otherwise — an untrusted client cannot forge a header to land
 * itself in a fresh bucket on every attempt.
 */
function getSocketClientAddress(socket) {
	const remoteAddress = socket?.conn?.remoteAddress;
	if (trustedProxy.isFromTrustedProxy(remoteAddress)) {
		const forwarded = String(socket?.handshake?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
		if (forwarded) {
			return forwarded;
		}
	}
	return remoteAddress || 'unknown';
}

export {
	createRateLimiter,
	getSocketClientAddress
};
