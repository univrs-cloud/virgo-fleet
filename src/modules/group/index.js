import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

/** A user only ever receives the groups they administer, so group existence, membership, and
 * shared-node details never leak to regular members or unrelated users. */
const emitGroups = async (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}
	try {
		const groups = await DataService.getManagedGroups(socket.userId);
		socket.emit('groups', groups);
	} catch (error) {
		console.error('Error emitting groups:', error);
	}
};

class GroupModule extends BaseModule {
	constructor() {
		super('group');

		this.eventEmitter.on('groups:updated', async () => {
			for (const socket of this.nsp.sockets.values()) {
				await emitGroups(socket);
			}
		});
	}

	onConnection(socket) {
		emitGroups(socket);
	}
}

export default () => {
	return new GroupModule();
};
