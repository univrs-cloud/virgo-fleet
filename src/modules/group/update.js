import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			if (!await DataService.isGroupAdmin(socket.userId, config.name)) {
				ack({ ok: false, error: 'Only a group admin can update this group' });
				return;
			}
			await DataService.updateGroup({
				name: config.name,
				newName: config.newName,
				description: config.description
			});
			module.eventEmitter.emit('groups:updated');
			ack({ ok: true, message: `Group ${config.name} updated.` });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'update',
	onConnection
};
