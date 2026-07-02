import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const createUser = async (config, socket, module) => {
	const email = normalizeEmail(config.email);
	if (!email) {
		throw new Error('email is required');
	}
	const existing = module.toArray(module.getState('users')).find((user) => {
		return user.email === email;
	});
	if (existing) {
		throw new Error('User already exists.');
	}
	if (!socket.isAdmin && config.role === 'admin') {
		config.role = '';
	}
	await DataService.createUser({
		email,
		displayName: config.fullname || config.displayName,
		password: config.password,
		isAdmin: config.role === 'admin'
	});
	module.eventEmitter.emit('users:updated');
	return `User ${email} created.`;
};

const onConnection = (socket, module) => {
	socket.on('user:create', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			const message = await createUser(config, socket, module);
			ack({ ok: true, message });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'create',
	onConnection
};
