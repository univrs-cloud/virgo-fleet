import BaseModule from '../base.js';

class AuthModule extends BaseModule {
	constructor() {
		super('auth');
	}
}

export default () => {
	return new AuthModule();
};
