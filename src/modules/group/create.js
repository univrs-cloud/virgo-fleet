import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:create', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			await DataService.createGroup({
				name: config.name,
				description: config.description,
				createdByUserId: socket.userId
			});
			module.eventEmitter.emit('groups:updated');
			ack({ status: 'succeeded', message: `Group ${config.name} created.` });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'create',
	onConnection
};
