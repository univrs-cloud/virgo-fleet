import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const emitNodes = async (socket, module) => {
	try {
		if (!socket.isAuthenticated) {
			return;
		}
		const nodes = await DataService.listAccessibleNodes(socket.userId);
		socket.emit('nodes', nodes.map((node) => {
			return {
				...node,
				online: module.isNodeOnline(node.nodeId)
			};
		}));
	} catch (error) {
		console.error('Error emitting nodes:', error);
	}
};

/** Per-user accessible node lists differ, so a plain `nsp.emit` broadcast can't be used; re-run `emitNodes` for each connected user socket instead. */
const broadcastNodes = async (module) => {
	for (const socket of module.nsp.sockets.values()) {
		if (socket.data?.role === 'user' && socket.isAuthenticated) {
			await emitNodes(socket, module);
		}
	}
};

const register = (module) => {
	module.eventEmitter.on('nodes:updated', () => {
		broadcastNodes(module).catch((error) => {
			console.error('Error broadcasting nodes:', error);
		});
	});
};

const onConnection = (socket, module) => {
	if (socket.data?.role === 'node') {
		return;
	}

	socket.on('node:invite', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ ok: false, error: 'Authentication required' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			const inviteEmail = normalizeEmail(config?.email);
			if (!nodeId || !inviteEmail) {
				ack({ ok: false, error: 'nodeId and email are required' });
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner) {
				ack({ ok: false, error: 'Only owner can invite users' });
				return;
			}
			await DataService.grantNodeAccess({
				email: inviteEmail,
				nodeId,
				role: 'invited'
			});
			module.eventEmitter.emit('nodes:updated');
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('node:members', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ ok: false, error: 'Authentication required' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			if (!nodeId) {
				ack({ ok: false, error: 'nodeId is required' });
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner) {
				ack({ ok: false, error: 'Only the owner can manage node access' });
				return;
			}
			const members = await DataService.listNodeMembers(nodeId);
			ack({ ok: true, ...members });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('node:revoke', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ ok: false, error: 'Authentication required' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			const revokeEmail = normalizeEmail(config?.email);
			if (!nodeId || !revokeEmail) {
				ack({ ok: false, error: 'nodeId and email are required' });
				return;
			}
			const isSelf = socket.email === revokeEmail;
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner && !isSelf) {
				ack({ ok: false, error: 'Only the owner or the account itself can manage node access' });
				return;
			}
			// Owner protection is also enforced in DataService.revokeNodeAccess itself, so it
			// can't be bypassed by the owner trying to remove themselves.
			await DataService.revokeNodeAccess({
				email: revokeEmail,
				nodeId
			});
			module.eventEmitter.emit('nodes:updated');
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('node:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ ok: false, error: 'Authentication required' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			if (!nodeId) {
				ack({ ok: false, error: 'nodeId is required' });
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner) {
				ack({ ok: false, error: 'Only the owner can delete this node' });
				return;
			}
			await DataService.deleteNode(nodeId);
			module.disconnectNode(nodeId);
			module.eventEmitter.emit('nodes:updated');
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('group:node:add', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const groupName = config.groupName || config.name;
			const owner = await DataService.isNodeOwner(socket.userId, config.nodeId);
			const groupAdmin = await DataService.isGroupAdmin(socket.userId, groupName);
			if (!owner || !groupAdmin) {
				ack({ ok: false, error: 'Only the node owner and a group admin can share a node with a group' });
				return;
			}
			await DataService.grantGroupNodeAccess({
				groupName: config.groupName || config.name,
				nodeId: config.nodeId
			});
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('nodes:updated');
			ack({ ok: true });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export {
	emitNodes
};

export default {
	name: 'proxy',
	onConnection,
	register
};
