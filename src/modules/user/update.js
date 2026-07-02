import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const updateUser = async (config, socket, module) => {
	const email = normalizeEmail(config.email);
	if (!email) {
		throw new Error('email is required');
	}
	const user = module.toArray(module.getState('users')).find((entry) => {
		return entry.email === email;
	});
	if (!user) {
		throw new Error(`User ${email} not found.`);
	}
	if (socket.email !== email) {
		throw new Error('Not allowed to update this user.');
	}
	await DataService.updateUser({
		email,
		displayName: config.fullname || config.displayName
	});
	module.eventEmitter.emit('users:updated');
	return `User ${email} updated.`;
};

const onConnection = (socket, module) => {
	socket.on('user:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const message = await updateUser(config, socket, module);
			ack({ ok: true, message });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'update',
	onConnection
};
