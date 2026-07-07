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
				ack({ ok: false, error: 'serialNumber, email and password are required' });
				return;
			}
			const owner = await DataService.verifyCredentials({ email, password });
			if (!owner) {
				ack({ ok: false, error: 'Invalid fleet credentials' });
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
			module.eventEmitter.emit('nodes:updated');
			ack({ ok: true, nodeId: serialNumber, token: node.token });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'register',
	onConnection
};
