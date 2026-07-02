import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

class GroupModule extends BaseModule {
	constructor() {
		super('group');

		(async () => {
			await this.#loadGroups();
		})();

		this.eventEmitter.on('groups:updated', async () => {
			await this.#loadGroups();
			this.nsp.sockets.forEach((socket) => {
				if (socket.isAuthenticated) {
					socket.emit('groups', this.getState('groups'));
				}
			});
		});
	}

	onConnection(socket) {
		if (this.getState('groups') && socket.isAuthenticated) {
			socket.emit('groups', this.getState('groups'));
		}
	}

	async #loadGroups() {
		try {
			const groups = await DataService.getGroups();
			this.setState('groups', groups);
		} catch (error) {
			this.setState('groups', false);
		}
	}
}

export default () => {
	return new GroupModule();
};
