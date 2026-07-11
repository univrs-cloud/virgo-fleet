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

		// groups:updated is always untargeted, so every change refreshes every connected socket.
		// Fan out concurrently — emitGroups is one query per socket and swallows its own errors, so
		// awaiting them serially would stall the whole broadcast on hundreds of sequential queries.
		this.eventEmitter.on('groups:updated', async () => {
			const sockets = [...this.nsp.sockets.values()];
			await Promise.all(sockets.map((socket) => emitGroups(socket)));
		});
	}

	onConnection(socket) {
		emitGroups(socket);
	}
}

export default () => {
	return new GroupModule();
};
