import DataService from '../database/data_service.js';
import createUserModule from './user/index.js';
import createGroupModule from './group/index.js';
import createAuthModule from './auth/index.js';
import createNodeModule from './node/index.js';

export default async () => {
	await DataService.initialize();

	const modules = [
		createUserModule(),
		createGroupModule(),
		createAuthModule(),
		createNodeModule()
	];

	return {
		modules
	};
};
