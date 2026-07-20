import DataService from '../services/data_service.js';
import { clearAuthCookies, getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';
import { sendSignupVerificationEmail } from '../emails/signup_verification/index.js';

async function signup(req, res) {
	let pending = null;
	try {
		pending = await DataService.createPendingUser({
			email: req.body?.email,
			name: req.body?.name,
			password: req.body?.password
		});
		await sendSignupVerificationEmail({
			to: pending.email,
			name: pending.name,
			token: pending.token
		});
		// No auth cookies here: the account is not usable until the emailed link is clicked.
		res.json({ status: 'succeeded', email: pending.email });
	} catch (error) {
		// If we created the pending row but the email never went out, drop it so the user can
		// retry immediately instead of hitting "a link was already sent" limbo.
		if (pending) {
			await DataService.deletePendingUser(pending.email).catch(() => {});
		}
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Called by the /signup/confirm screen with the token from the email link. On success the account
// is promoted and the (MFA-gated, setup_required) session cookies are set; the screen then navigates
// on and the app forces enrollment. Returns JSON — it's a fetch, not a browser navigation.
async function verify(req, res) {
	try {
		const result = await DataService.verifyPendingUser(req.body?.token);
		setAuthCookies(res, req, { token: result.token, user: result.user, mfaState: result.mfaState });
		res.json({ status: 'succeeded', mfa: result.mfaState === 'satisfied' ? null : result.mfaState });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

async function login(req, res) {
	try {
		const result = await DataService.login({
			email: req.body?.email,
			password: req.body?.password
		});
		// The session is gated (setup_required / challenge_required) until MFA is satisfied; the UI
		// reloads and the account cookie's mfa flag routes it to the setup or challenge screen.
		setAuthCookies(res, req, { token: result.token, user: result.user, mfaState: result.mfaState });
		res.json({ status: 'succeeded', mfa: result.mfaState === 'satisfied' ? null : result.mfaState });
	} catch (error) {
		res.status(401).json({ status: 'failed', message: error.message });
	}
}

// Loads the session behind the request's cookie. Returns nulls when absent/expired.
async function sessionFromRequest(req) {
	const token = getSessionTokenFromCookieHeader(req.headers.cookie);
	const session = token ? await DataService.getSessionByToken(token) : null;
	return { token, session, user: session?.FleetUser || null };
}

// Begin TOTP enrollment — only reachable by a session that's actually in setup_required. Returns
// the secret + otpauth URI for the client to render as a QR.
async function mfaSetup(req, res) {
	try {
		const { session, user } = await sessionFromRequest(req);
		if (!user || session.mfaState !== 'setup_required') {
			res.status(403).json({ status: 'failed', message: 'Not allowed.' });
			return;
		}
		const { secret, otpauthUrl } = await DataService.beginTotpSetup(user.id);
		res.json({ status: 'succeeded', secret, otpauthUrl });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Confirm enrollment with the first code; on success the session becomes satisfied and the
// one-time recovery codes are returned to show once.
async function mfaSetupVerify(req, res) {
	try {
		const { token, session, user } = await sessionFromRequest(req);
		if (!user || session.mfaState !== 'setup_required') {
			res.status(403).json({ status: 'failed', message: 'Not allowed.' });
			return;
		}
		const { recoveryCodes } = await DataService.confirmTotpSetup(user.id, req.body?.code);
		await DataService.setSessionMfaState(token, 'satisfied');
		setAuthCookies(res, req, { token, user, mfaState: 'satisfied' });
		res.json({ status: 'succeeded', recoveryCodes });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

// Clear the login TOTP challenge with a code or a recovery code; on success the session is lifted
// to satisfied.
async function mfaVerify(req, res) {
	try {
		const { token, session, user } = await sessionFromRequest(req);
		if (!user || session.mfaState !== 'challenge_required') {
			res.status(403).json({ status: 'failed', message: 'Not allowed.' });
			return;
		}
		const recoveryCode = req.body?.recoveryCode;
		const passed = recoveryCode
			? await DataService.consumeRecoveryCode(user.id, recoveryCode)
			: await DataService.verifyTotpChallenge(user.id, req.body?.code);
		if (!passed) {
			res.status(401).json({ status: 'failed', message: 'That code is not valid.' });
			return;
		}
		await DataService.setSessionMfaState(token, 'satisfied');
		setAuthCookies(res, req, { token, user, mfaState: 'satisfied' });
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

const MIN_PASSWORD_LENGTH = 8;

// Self-service password change for the logged-in fleet user. This lives on HTTP (not a socket)
// on purpose: DataService.changePassword invalidates every session, and only an HTTP response can
// clear this browser's auth cookies in the same round-trip — leaving the UI cleanly logged out.
async function changePassword(req, res) {
	try {
		const token = getSessionTokenFromCookieHeader(req.headers.cookie);
		const session = token ? await DataService.getSessionByToken(token) : null;
		const user = session?.FleetUser || null;
		if (!user || session.mfaState !== 'satisfied') {
			res.status(401).json({ status: 'failed', message: 'Not authenticated.' });
			return;
		}
		const currentPassword = req.body?.currentPassword;
		const password = req.body?.password;
		if (!currentPassword) {
			throw new Error('Current password is required.');
		}
		if (!password || password.length < MIN_PASSWORD_LENGTH) {
			throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
		}
		// Prove the caller knows the current password before rehashing — a live session alone
		// isn't enough to reset the credential.
		const verified = await DataService.verifyCredentials({ email: user.email, password: currentPassword });
		if (!verified) {
			throw new Error('Current password is incorrect.');
		}
		await DataService.changePassword(user.email, password);
		clearAuthCookies(res, req);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(400).json({ status: 'failed', message: error.message });
	}
}

async function logout(req, res) {
	try {
		const token = getSessionTokenFromCookieHeader(req.headers.cookie);
		if (token) {
			await DataService.deleteSession(token);
		}
		clearAuthCookies(res, req);
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(500).json({ status: 'failed', message: error.message });
	}
}

export {
	signup,
	verify,
	login,
	logout,
	changePassword,
	mfaSetup,
	mfaSetupVerify,
	mfaVerify
};
