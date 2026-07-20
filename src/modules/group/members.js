import DataService from '../../services/data_service.js';
import { normalizeEmail } from '../../utils/email.js';
import { revokeStaleNodeAccess } from '../../utils/node_proxy.js';

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
			// Capture the user and the group's shared nodes before the removal, then enforce: any live
			// proxy session to a node the user can no longer reach is torn down (access is otherwise
			// only checked at connect time), and their inventory is refreshed so the node disappears.
			const removed = await DataService.getUserByEmail(email);
			const groupNodeIds = await DataService.listGroupNodeIds(config.groupId);
			await DataService.removeUserFromGroup({
				groupId: config.groupId,
				email
			});
			if (removed) {
				await revokeStaleNodeAccess([removed.id], groupNodeIds);
				module.eventEmitter.emit('nodes:updated', { userIds: [removed.id] });
			}
			module.eventEmitter.emit('groups:updated');
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
