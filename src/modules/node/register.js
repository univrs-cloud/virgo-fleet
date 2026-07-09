import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	if (socket.data?.role !== 'node') {
		return;
	}

	socket.on('node:register', async (config, ack = () => {}) => {
		try {
			const serialNumber = String(config?.serialNumber || config?.nodeId || '').trim();
			const name = String(config?.name || '').trim() || serialNumber;
			const email = String(config?.email || '').trim().toLowerCase();
			const password = String(config?.password || '');
			if (!serialNumber || !email || !password) {
				ack({ status: 'failed', message: 'serialNumber, email and password are required.' });
				return;
			}
			const owner = await DataService.verifyCredentials({ email, password });
			if (!owner) {
				ack({ status: 'failed', message: 'Invalid fleet credentials.' });
				return;
			}
			const node = await DataService.upsertNode({
				nodeId: serialNumber,
				name,
				ownerUserId: owner.id
			});
			await DataService.grantNodeAccess({
				email: owner.email,
				nodeId: serialNumber,
				role: 'owner'
			});
			socket.data.nodeId = serialNumber;
			module.setNodeSocket(serialNumber, socket);
			module.eventEmitter.emit('nodes:updated', { userIds: [owner.id] });
			ack({ status: 'succeeded', nodeId: serialNumber, token: node.token });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'register',
	onConnection
};
