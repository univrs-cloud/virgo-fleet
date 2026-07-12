import BaseModule from '../base.js';

/**
 * The fleet `/user` namespace hosts only self-service actions (update, delete) that operate on the
 * authenticated socket's own account. There is no fleet-wide admin or super-user, so this module
 * deliberately does not load, cache, or emit any list of users — a fleet user can neither enumerate
 * nor read other accounts. The plugins derive identity from the session (socket), never from a
 * client-supplied user list.
 */
class UserModule extends BaseModule {
	constructor() {
		super('user');
	}
}

export default () => {
	return new UserModule();
};
