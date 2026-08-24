import * as trustedProxy from './trusted_proxy.js';

// Long enough for any real browser's agent, short enough that the header can't write megabytes
// into the sessions table.
const MAX_USER_AGENT_LENGTH = 512;

function normalizeAddress(address) {
	if (!address || typeof address !== 'string') {
		return null;
	}
	return address.replace(/^::ffff:/i, '').trim() || null;
}

function normalizeUserAgent(value) {
	const agent = String(value ?? '').trim();
	return agent ? agent.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

/**
 * The client address recorded on a session: the first X-Forwarded-For entry when the TCP peer is a
 * trusted proxy, the peer address otherwise — the same rule the rate limiter keys on, so an
 * untrusted client can't forge a header and have someone else's address show up in the profile.
 */
function resolveAddress(remoteAddress, forwardedHeader) {
	if (trustedProxy.isFromTrustedProxy(remoteAddress)) {
		const forwarded = normalizeAddress(String(forwardedHeader ?? '').split(',')[0]);
		if (forwarded) {
			return forwarded;
		}
	}
	return normalizeAddress(remoteAddress);
}

function getRequestClientContext(req) {
	return {
		ipAddress: resolveAddress(req?.socket?.remoteAddress, req?.headers?.['x-forwarded-for']),
		userAgent: normalizeUserAgent(req?.headers?.['user-agent'])
	};
}

function getSocketClientContext(socket) {
	const headers = socket?.handshake?.headers ?? {};
	return {
		ipAddress: resolveAddress(socket?.conn?.remoteAddress, headers['x-forwarded-for']),
		userAgent: normalizeUserAgent(headers['user-agent'])
	};
}

export {
	getRequestClientContext,
	getSocketClientContext
};
