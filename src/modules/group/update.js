import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ status: 'failed', message: 'Only a group manager can update this group.' });
				return;
			}
			await DataService.updateGroup({
				groupId: config.groupId,
				newName: config.newName,
				description: config.description
			});
			module.eventEmitter.emit('groups:updated');
			ack({ status: 'succeeded', message: 'Group updated.' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'update',
	onConnection
};
