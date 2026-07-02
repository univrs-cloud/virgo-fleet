import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupAdmin(socket.userId, config.name)) {
				ack({ ok: false, error: 'Only a group admin can delete this group' });
				return;
			}
			await DataService.deleteGroup(config.name);
			module.eventEmitter.emit('groups:updated');
			ack({ ok: true, message: `Group ${config.name} deleted.` });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'delete',
	onConnection
};
