import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const changePassword = async (config, socket, module) => {
	const email = normalizeEmail(config.email);
	if (!email) {
		throw new Error('email is required.');
	}
	const user = module.toArray(module.getState('users')).find((entry) => {
		return entry.email === email;
	});
	if (!user) {
		throw new Error(`User ${email} not found.`);
	}
	if (socket.email !== email) {
		throw new Error('Not allowed to change this password.');
	}
	await DataService.changePassword(email, config.password);
	return `${email} password changed.`;
};

const onConnection = (socket, module) => {
	socket.on('user:password', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const message = await changePassword(config, socket, module);
			ack({ status: 'succeeded', message });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'change_password',
	onConnection
};
