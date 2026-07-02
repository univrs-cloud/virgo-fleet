import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const onConnection = (socket, module) => {
	socket.on('group:user:add', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ ok: false, error: 'email is required' });
				return;
			}
			await DataService.addUserToGroup({
				groupName: config.groupName || config.name,
				email,
				role: config.role || 'member'
			});
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('users:updated');
			ack({ ok: true, message: `User ${email} added to group.` });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('group:user:remove', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ ok: false, error: 'email is required' });
				return;
			}
			await DataService.removeUserFromGroup({
				groupName: config.groupName || config.name,
				email
			});
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('users:updated');
			ack({ ok: true, message: `User ${email} removed from group.` });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'members',
	onConnection
};
