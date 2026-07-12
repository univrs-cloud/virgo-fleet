import DataService from '../database/data_service.js';
import { clearAuthCookies, getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';
import { sendSignupVerificationEmail } from '../emails/signup_verification/index.js';

async function signup(req, res) {
	let pending = null;
	try {
		pending = await DataService.createPendingUser({
			email: req.body?.email,
			displayName: req.body?.displayName,
			password: req.body?.password
		});
		await sendSignupVerificationEmail({
			to: pending.email,
			displayName: pending.displayName,
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

// Landing point for the link in the verification email. On success the account is promoted
// and logged in via cookies, then redirected into the app; on failure it redirects back to
// the login screen with a flag the UI can surface.
async function verify(req, res) {
	try {
		const result = await DataService.verifyPendingUser(req.query?.token);
		setAuthCookies(res, req, { token: result.token, user: result.user });
		res.redirect('/');
	} catch (error) {
		res.redirect(`/?verify=failed&reason=${encodeURIComponent(error.message)}`);
	}
}

async function login(req, res) {
	try {
		const result = await DataService.login({
			email: req.body?.email,
			password: req.body?.password
		});
		setAuthCookies(res, req, { token: result.token, user: result.user });
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(401).json({ status: 'failed', message: error.message });
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
		if (!user) {
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
	changePassword
};
