import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const deleteUser = async (config, socket, module) => {
	const email = normalizeEmail(config.email);
	if (!email) {
		throw new Error('email is required');
	}
	const user = module.toArray(module.getState('users')).find((entry) => {
		return entry.email === email;
	});
	if (!user) {
		throw new Error(`User ${email} not found.`);
	}
	if (socket.email !== email) {
		throw new Error('Not allowed to delete this user.');
	}
	// Keep a reference to the owned nodes before deletion, since the DB cascade will remove their
	// records. Deleting the user removes the nodes they own and the groups they created, which in
	// turn cascade all memberships, access rows, and node shares.
	const ownedNodeIds = await DataService.listNodesOwnedBy(socket.userId);
	await DataService.deleteUser(email);
	module.eventEmitter.emit('users:updated');
	module.eventEmitter.emit('nodes:updated');
	module.eventEmitter.emit('groups:updated');
	// Records are already gone; tell those nodes to unregister (wipe their own fleet config).
	if (ownedNodeIds.length) {
		module.eventEmitter.emit('nodes:unregister', { nodeIds: ownedNodeIds });
	}
	return `User ${email} deleted.`;
};

const onConnection = (socket, module) => {
	socket.on('user:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const message = await deleteUser(config, socket, module);
			ack({ ok: true, message });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'delete',
	onConnection
};
