import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ ok: false, error: 'Only a group manager can update this group' });
				return;
			}
			await DataService.updateGroup({
				groupId: config.groupId,
				newName: config.newName,
				description: config.description
			});
			module.eventEmitter.emit('groups:updated');
			ack({ ok: true, message: 'Group updated.' });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'update',
	onConnection
};
