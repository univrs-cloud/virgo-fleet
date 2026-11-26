import DataService from '../../services/data_service.js';

const emitRecoveryCodes = async (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}
	try {
		const summary = await DataService.getRecoveryCodesSummary(socket.userId);
		socket.emit('user:recovery-codes', summary);
	} catch (error) {
		console.error('Error emitting recovery codes:', error);
	}
};

const register = (module) => {
	module.eventEmitter.on('recovery-codes:updated', async ({ userId } = {}) => {
		try {
			const sockets = [...module.nsp.sockets.values()].filter((socket) => {
				return socket.userId === userId;
			});
			await Promise.all(sockets.map((socket) => { return emitRecoveryCodes(socket); }));
		} catch (error) {
			console.error('Error broadcasting recovery codes:', error);
		}
	});
};

const onConnection = (socket) => {
	emitRecoveryCodes(socket);
};

export default {
	name: 'recovery_codes',
	register,
	onConnection
};
