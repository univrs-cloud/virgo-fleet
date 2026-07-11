import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const updateUser = async (config, socket, module) => {
	const email = normalizeEmail(config.email);
	if (!email) {
		throw new Error('email is required.');
	}
	const user = module.toArray(module.getState('users')).find((entry) => {
		return entry.email === email;
	});
	if (!user) {
		throw new Error(`User ${email} not found.`);
	}
	if (socket.email !== email) {
		throw new Error('Not allowed to update this user.');
	}
	await DataService.updateUser({
		email,
		displayName: config.fullname || config.displayName
	});
	module.eventEmitter.emit('users:updated');
	// The new displayName is embedded in other users' views too: a node owner's admins list and a
	// group manager's member roster both show it. users:updated only refreshes each socket's own
	// record, so target the affected node owners and refresh group rosters (groups:updated is
	// untargeted) — otherwise they keep showing the old name until a reload.
	const affectedOwnerIds = await DataService.listNodeOwnersForMember(socket.userId);
	module.eventEmitter.emit('nodes:updated', { userIds: affectedOwnerIds });
	module.eventEmitter.emit('groups:updated');
	return `User ${email} updated.`;
};

const onConnection = (socket, module) => {
	socket.on('user:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const message = await updateUser(config, socket, module);
			ack({ status: 'succeeded', message });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'update',
	onConnection
};
