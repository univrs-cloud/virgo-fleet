import BaseModule from '../base.js';

class RuntimeModule extends BaseModule {
	constructor() {
		super('runtime');
	}

	onConnection(socket) {
		socket.emit('role', 'fleet');
	}
}

export default () => {
	return new RuntimeModule();
};
