const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;
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

function getCookieOptions(req) {
	return {
		domain: req.hostname,
		encode: String,
		httpOnly: false,
		secure: true,
		sameSite: 'lax',
		maxAge: SIX_MONTHS_MS
	};
}

function buildAccountFromUser(user) {
	return {
		name: user.displayName || user.email,
		user: user.email,
		email: user.email,
		groups: user.isAdmin ? ['admins'] : ['users']
	};
}

function serializeAccount(account) {
	return Buffer.from(JSON.stringify(account)).toString('base64');
}

function setAuthCookies(res, req, { token, user }) {
	const cookieOptions = getCookieOptions(req);
	const account = buildAccountFromUser(user);
	res.cookie('virgo.session', token, cookieOptions);
	res.cookie('account', serializeAccount(account), cookieOptions);
}

function clearAuthCookies(res, req) {
	const cookieOptions = getCookieOptions(req);
	res.cookie('virgo.session', '', cookieOptions);
	res.cookie('account', '', cookieOptions);
}

export {
	SIX_MONTHS_MS,
	SESSION_COOKIE,
	parseCookieHeader,
	getSessionTokenFromCookieHeader,
	getCookieOptions,
	buildAccountFromUser,
	serializeAccount,
	setAuthCookies,
	clearAuthCookies
};
