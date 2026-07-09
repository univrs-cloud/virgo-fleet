import DataService from '../../database/data_service.js';
import { getSessionTokenFromCookieHeader } from '../../utils/auth_cookies.js';

const onConnection = (socket, module) => {
	socket.on('auth:signup', async (config, ack = () => {}) => {
		try {
			const result = await DataService.signup({
				email: config.email,
				displayName: config.fullname || config.displayName,
				password: config.password
			});
			module.eventEmitter.emit('users:updated');
			ack({ status: 'succeeded', ...result });
		} catch (error) {
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
