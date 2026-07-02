import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:create', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			await DataService.createGroup({
				name: config.name,
				description: config.description
			});
			module.eventEmitter.emit('groups:updated');
			ack({ ok: true, message: `Group ${config.name} created.` });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'create',
	onConnection
};
