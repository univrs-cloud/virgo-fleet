import crypto from 'crypto';

// The node proxy's WebRTC data channel is browser <-> node direct. A node on a public address is
// reached directly; a node behind CGNAT is reached through coturn, which fleet runs as its own
// sidecar (see the README). coturn is configured with `use-auth-secret`, so credentials are not
// stored per user — fleet derives a short-lived one from the shared secret on demand and hands it
// to both peers in the signaling exchange. The TTL only has to cover ICE establishment; once a
// relay allocation is bound it lives for the session.

const DEFAULT_LISTENING_PORT = 3477;
const DEFAULT_TTL_SECONDS = 300;

const settings = () => {
	const domain = String(process.env.DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
	return {
		secret: String(process.env.TURN_SECRET_KEY || '').trim(),
		host: domain ? `relay.${domain}` : '',
		listeningPort: Number(process.env.TURN_LISTENING_PORT) || DEFAULT_LISTENING_PORT,
		ttlSeconds: Number(process.env.TURN_TTL_SECONDS) || DEFAULT_TTL_SECONDS
	};
};

/** A coturn REST-API ephemeral credential: the username is `<expiry-unix>:<userId>` and the
 * password is the HMAC-SHA1 of that username keyed by the shared static-auth-secret. coturn
 * recomputes the same HMAC to verify, so nothing is stored. Returns null when no secret is
 * configured. */
const mintTurnCredentials = (userId) => {
	const { secret, ttlSeconds } = settings();
	if (!secret) {
		return null;
	}
	const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId ?? 'anonymous'}`;
	const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
	return { username, credential, ttlSeconds };
};

/** The ICE server list handed to a browser and to a node for one WebRTC session. Always includes
 * STUN when a host is configured; includes TURN only when a secret is set, so an unconfigured
 * fleet still signals but offers direct-only connectivity. Both TURN transports are advertised:
 * `transport` selects the peer's leg to coturn (TCP gets through networks that block UDP), not the
 * relay allocation itself, which browsers always request over UDP. */
const iceServers = (userId) => {
	const { host, listeningPort } = settings();
	if (!host) {
		return [];
	}
	const servers = [{ urls: `stun:${host}:${listeningPort}` }];
	const credentials = mintTurnCredentials(userId);
	if (credentials) {
		servers.push({
			urls: [
				`turn:${host}:${listeningPort}?transport=udp`,
				`turn:${host}:${listeningPort}?transport=tcp`
			],
			username: credentials.username,
			credential: credentials.credential
		});
	}
	return servers;
};

export {
	mintTurnCredentials,
	iceServers
};
