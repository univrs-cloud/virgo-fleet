import DataService from '../../database/data_service.js';

const onConnection = (socket, module) => {
	socket.on('group:invite', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const groupName = config.groupName || config.name;
			if (!await DataService.isGroupAdmin(socket.userId, groupName)) {
				ack({ ok: false, error: 'Only a group admin can invite users' });
				return;
			}
			const invite = await DataService.createGroupInvite({
				groupName: config.groupName || config.name,
				invitedByUserId: socket.userId,
				email: config.email
			});
			ack({
				ok: true,
				inviteToken: invite.token,
				message: `Invite created for group ${config.groupName || config.name}.`
			});
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('group:invite:accept', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			await DataService.acceptGroupInvite(config.token, socket.email);
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('users:updated');
			ack({ ok: true, message: 'Invite accepted.' });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'invite',
	onConnection
};
