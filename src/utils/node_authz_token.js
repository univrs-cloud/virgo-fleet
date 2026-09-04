import crypto from 'crypto';

// The browser's WebRTC data channel to a node bypasses fleet, so the node can no longer lean on
// "the fleet control socket vouches for each event". Instead fleet signs the session's identity
// with the node's own registration token (a secret shared only between that node and fleet) and
// the node recomputes the HMAC before it will open a peer connection. The claims mirror what the
// Socket.IO proxy passes in `proxy:open`, so the node's loopback handshake and `base.js` see an
// unchanged user. exp is deliberately short — it only has to outlast the offer/answer round-trip,
// not the session, which lives as long as the browser's signaling socket.

const TOKEN_TTL_MS = 60_000;

const base64url = (value) => {
	return Buffer.from(value).toString('base64url');
};

/** Signs `{ nodeId, sid, userId, email, groups, ... }` with the node's registration token.
 * Returns `<payload>.<signature>`, both base64url. */
const mintNodeSessionToken = ({ nodeId, sessionId, userId, email, nodeToken }) => {
	const now = Date.now();
	const payload = base64url(JSON.stringify({
		nodeId,
		sid: sessionId,
		userId: userId ?? null,
		email: email ?? null,
		groups: ['admins'],
		transport: 'webrtc',
		iat: now,
		exp: now + TOKEN_TTL_MS
	}));
	const signature = base64url(crypto.createHmac('sha256', nodeToken).update(payload).digest());
	return `${payload}.${signature}`;
};

export {
	mintNodeSessionToken,
	TOKEN_TTL_MS
};
