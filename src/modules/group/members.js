import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const onConnection = (socket, module) => {
	socket.on('group:user:add', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ status: 'failed', message: 'Only a group manager can add users to this group.' });
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ status: 'failed', message: 'email is required.' });
				return;
			}
			await DataService.addUserToGroup({
				groupId: config.groupId,
				email,
				role: config.role || 'member'
			});
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('users:updated');
			ack({ status: 'succeeded', message: `User ${email} added to group.` });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('group:user:remove', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ status: 'failed', message: 'Only a group manager can remove users from this group.' });
				return;
			}
			const email = normalizeEmail(config.email);
			if (!email) {
				ack({ status: 'failed', message: 'email is required.' });
				return;
			}
			await DataService.removeUserFromGroup({
				groupId: config.groupId,
				email
			});
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('users:updated');
			ack({ status: 'succeeded', message: `User ${email} removed from group.` });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'members',
	onConnection
};
