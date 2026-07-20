// Keep in sync with DataService's SESSION_TTL_MS so the cookie and the server-side session
// expire together (both 30 days).
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_COOKIE = 'virgo.session';

function parseCookieHeader(cookieHeader, name) {
	if (!cookieHeader) {
		return null;
	}
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match ? decodeURIComponent(match[1]) : null;
}

function getSessionTokenFromCookieHeader(cookieHeader) {
	return parseCookieHeader(cookieHeader, SESSION_COOKIE);
}

function getCookieOptions(req, { httpOnly = false } = {}) {
	return {
		domain: req.hostname,
		encode: String,
		httpOnly,
		secure: true,
		sameSite: 'lax',
		maxAge: SESSION_TTL_MS
	};
}

/**
 * Fleet accounts carry the 'admins' group so the reused node-shell UI renders its admin
 * controls when a user opens a node they can access. This cookie flag is display-only:
 * the real authorization is still enforced per-node on the server (canUserAccessNode gates
 * every proxy namespace), so the group here never widens what a user can actually reach.
 */
function mfaFlag(mfaState) {
	if (mfaState === 'setup_required') {
		return 'setup';
	}
	if (mfaState === 'challenge_required') {
		return 'challenge';
	}
	return null;
}

function buildAccountFromUser(user, mfaState = 'satisfied') {
	const account = {
		name: user.name || user.email,
		user: user.email,
		email: user.email,
		groups: ['admins'],
		pushEnabled: Boolean(user.pushEnabled)
	};
	// Readable by the UI so the bootstrap can route a gated session to the forced setup/challenge
	// screen instead of the dashboard. Absent once the session is satisfied.
	const mfa = mfaFlag(mfaState);
	if (mfa) {
		account.mfa = mfa;
	}
	return account;
}

function serializeAccount(account) {
	return Buffer.from(JSON.stringify(account)).toString('base64');
}

function setAuthCookies(res, req, { token, user, mfaState = 'satisfied' }) {
	const account = buildAccountFromUser(user, mfaState);
	// The session token is the credential — keep it httpOnly so page scripts (and any XSS) can't
	// read it. The account cookie is display-only and must stay readable by the UI.
	res.cookie('virgo.session', token, getCookieOptions(req, { httpOnly: true }));
	res.cookie('account', serializeAccount(account), getCookieOptions(req));
}

function clearAuthCookies(res, req) {
	res.cookie('virgo.session', '', getCookieOptions(req, { httpOnly: true }));
	res.cookie('account', '', getCookieOptions(req));
}

export {
	SESSION_TTL_MS,
	SESSION_COOKIE,
	parseCookieHeader,
	getSessionTokenFromCookieHeader,
	getCookieOptions,
	buildAccountFromUser,
	serializeAccount,
	setAuthCookies,
	clearAuthCookies
};
