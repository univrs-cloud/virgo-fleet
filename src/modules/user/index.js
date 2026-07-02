import BaseModule from '../base.js';
import DataService from '../../database/data_service.js';

class UserModule extends BaseModule {
	constructor() {
		super('user');

		(async () => {
			await this.#loadUsers();
		})();

		this.eventEmitter.on('users:updated', async () => {
			await this.#loadUsers();
			this.nsp.sockets.forEach((socket) => {
				if (socket.isAuthenticated) {
					if (!socket.isAdmin) {
						socket.emit('users', this.toArray(this.getState('users')).filter((user) => { return user.email === socket.email; }));
					} else {
						socket.emit('users', this.getState('users'));
					}
				}
			});
		});
	}

	onConnection(socket) {
		if (this.getState('users') && socket.isAuthenticated) {
			if (!socket.isAdmin) {
				socket.emit('users', this.toArray(this.getState('users')).filter((user) => { return user.email === socket.email; }));
			} else {
				socket.emit('users', this.getState('users'));
			}
		}
	}

	async #loadUsers() {
		try {
			const users = await DataService.getUsers();
			this.setState('users', users);
		} catch (error) {
			this.setState('users', false);
		}
	}
}

export default () => {
	return new UserModule();
};
