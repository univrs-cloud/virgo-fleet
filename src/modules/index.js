import createRuntimeModule from './runtime/index.js';
import createUserModule from './user/index.js';
import createGroupModule from './group/index.js';
import createAuthModule from './auth/index.js';
import createNodeModule from './node/index.js';

export default async () => {
	const modules = [
		createRuntimeModule(),
		createUserModule(),
		createGroupModule(),
		createAuthModule(),
		createNodeModule()
	];

	return {
		modules
	};
};
