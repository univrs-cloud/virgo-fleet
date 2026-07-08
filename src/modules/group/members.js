import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const onConnection = (socket, module) => {
	socket.on('group:user:add', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupAdmin(socket.userId, config.groupId)) {
				ack({ ok: false, error: 'Only a group admin can add users to this group' });
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ ok: false, error: 'email is required' });
				return;
			}
			await DataService.addUserToGroup({
				groupId: config.groupId,
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
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupAdmin(socket.userId, config.groupId)) {
				ack({ ok: false, error: 'Only a group admin can remove users from this group' });
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ ok: false, error: 'email is required' });
				return;
			}
			await DataService.removeUserFromGroup({
				groupId: config.groupId,
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
