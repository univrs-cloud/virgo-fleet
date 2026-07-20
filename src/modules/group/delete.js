import DataService from '../../services/data_service.js';
import { revokeStaleNodeAccess } from '../../utils/node_proxy.js';

const onConnection = (socket, module) => {
	socket.on('group:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ status: 'failed', message: 'Only a group manager can delete this group.' });
				return;
			}
			// Deleting the group revokes access to every node it shared, for every member. Capture both
			// before deletion, then enforce: tear down live proxy sessions to nodes a member can no
			// longer reach and refresh their inventory (access is otherwise only checked at connect).
			const memberIds = await DataService.listGroupMemberUserIds(config.groupId);
			const groupNodeIds = await DataService.listGroupNodeIds(config.groupId);
			await DataService.deleteGroup(config.groupId);
			await revokeStaleNodeAccess(memberIds, groupNodeIds);
			if (memberIds.length) {
				module.eventEmitter.emit('nodes:updated', { userIds: memberIds });
			}
			module.eventEmitter.emit('groups:updated');
			ack({ status: 'succeeded', message: 'Group deleted.' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'delete',
	onConnection
};
