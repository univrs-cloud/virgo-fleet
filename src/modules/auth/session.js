import DataService from '../../services/data_service.js';
import { getSessionTokenFromCookieHeader } from '../../utils/auth_cookies.js';
import { sendSignupVerificationEmail } from '../../emails/signup_verification/index.js';

const onConnection = (socket, module) => {
	socket.on('auth:signup', async (config, ack = () => {}) => {
		let pending = null;
		try {
			pending = await DataService.createPendingUser({
				email: config.email,
				displayName: config.fullname || config.displayName,
				password: config.password
			});
			await sendSignupVerificationEmail({
				to: pending.email,
				displayName: pending.displayName,
				token: pending.token
			});
			// No session is returned: the account only becomes real once the emailed link is clicked.
			ack({ status: 'succeeded', email: pending.email });
		} catch (error) {
			if (pending) {
				await DataService.deletePendingUser(pending.email).catch(() => {});
			}
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('auth:login', async (config, ack = () => {}) => {
		try {
			const result = await DataService.login({
				email: config.email,
				password: config.password
			});
			ack({ status: 'succeeded', ...result });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('auth:logout', async (_config, ack = () => {}) => {
		try {
			const token = getSessionTokenFromCookieHeader(socket.handshake?.headers?.cookie);
			if (token) {
				await DataService.deleteSession(token);
			}
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'session',
	onConnection
};
