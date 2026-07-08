import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupManager(socket.userId, config.groupId)) {
				ack({ ok: false, error: 'Only a group manager can delete this group' });
				return;
			}
			await DataService.deleteGroup(config.groupId);
			module.eventEmitter.emit('groups:updated');
			ack({ ok: true, message: 'Group deleted.' });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'delete',
	onConnection
};
