import DataService from '../../services/data_service.js';

// A fleet user can only update their own account: identity comes from the authenticated session,
// never from client input, and no list of users is consulted.
const updateUser = async (config, socket, module) => {
	const email = socket.email;
	await DataService.updateUser({
		email,
		name: config.name
	});
	// The new name is embedded in other users' views too: a node owner's admins list and a
	// group manager's member roster both show it. Refresh the affected node owners and group rosters
	// (groups:updated is untargeted) — otherwise they keep showing the old name until a reload.
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
