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
	// Capture the user's owned nodes before deletion (afterwards ownerUserId is nulled), then hand
	// them to the node module to unregister + delete so no orphaned nodes are left behind.
	const ownedNodeIds = await DataService.listNodesOwnedBy(socket.userId);
	await DataService.deleteUser(email);
	module.eventEmitter.emit('users:updated');
	if (ownedNodeIds.length) {
		module.eventEmitter.emit('nodes:owner:removed', { nodeIds: ownedNodeIds });
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
