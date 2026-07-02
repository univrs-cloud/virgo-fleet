import BaseModule from '../base.js';

class RuntimeModule extends BaseModule {
	constructor() {
		super('runtime');
	}

	onConnection(socket) {
		socket.emit('runtime', { role: 'fleet' });
	}
}

export default () => {
	return new RuntimeModule();
};
