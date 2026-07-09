import DataService from '../database/data_service.js';
import { clearAuthCookies, getSessionTokenFromCookieHeader, setAuthCookies } from '../utils/auth_cookies.js';

async function signup(req, res) {
	try {
		const result = await DataService.signup({
			email: req.body?.email,
			displayName: req.body?.displayName,
			password: req.body?.password
		});
		setAuthCookies(res, req, { token: result.token, user: result.user });
		res.json({ status: 'succeeded' });
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
		setAuthCookies(res, req, { token: result.token, user: result.user });
		res.json({ status: 'succeeded' });
	} catch (error) {
		res.status(401).json({ status: 'failed', message: error.message });
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
	login,
	logout
};
