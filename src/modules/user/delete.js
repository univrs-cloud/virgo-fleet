import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const deleteUser = async (config, module) => {
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
	await DataService.deleteUser(email);
	module.eventEmitter.emit('users:updated');
	return `User ${email} deleted.`;
};

const onConnection = (socket, module) => {
	socket.on('user:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			const message = await deleteUser(config, module);
			ack({ ok: true, message });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'delete',
	onConnection
};
