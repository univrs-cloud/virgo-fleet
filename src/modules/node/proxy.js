import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';

const FLEET_UNREGISTER_TIMEOUT_MS = 5000;

const emitNodes = async (socket, module) => {
	try {
		if (!socket.isAuthenticated) {
			return;
		}
		const nodes = await DataService.listAccessibleNodes(socket.userId);
		const inventory = await Promise.all(nodes.map(async (node) => {
			const entry = {
				...node,
				online: module.isNodeOnline(node.nodeId)
			};
			if (node.isOwner) {
				const members = await DataService.listNodeMembers(node.nodeId);
				entry.admins = (members.users || [])
					.filter((user) => { return user.role !== 'owner'; })
					.map((user) => { return { email: user.email, displayName: user.displayName }; });
			}
			return entry;
		}));
		socket.emit('node:inventory', inventory);
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
			const invitee = await DataService.getUserByEmail(inviteEmail);
			if (!invitee) {
				ack({ ok: false, error: 'No account exists for that email address' });
				return;
			}
			if (await DataService.isNodeOwner(invitee.id, nodeId)) {
				ack({ ok: false, error: 'The node owner already has access' });
				return;
			}
			if (await DataService.canUserAccessNode(invitee.id, nodeId)) {
				ack({ ok: false, error: 'This account already has access' });
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
				const allowed = await DataService.canUserAccessNode(socket.userId, nodeId);
				if (!allowed) {
					ack({ ok: false, error: 'Access denied for node' });
					return;
				}
				// An invited admin only detaches their own access; the node itself is untouched.
				await DataService.revokeNodeAccess({ email: socket.email, nodeId });
				module.eventEmitter.emit('nodes:updated');
				ack({ ok: true });
				return;
			}

			// The owner tears the node down: ask an online node to unregister (wiping its
			// own fleet configuration) first, then clean up the fleet database regardless
			// of the outcome.
			const nodeSocket = module.getNodeSocket(nodeId);
			if (nodeSocket?.connected) {
				try {
					await nodeSocket.timeout(FLEET_UNREGISTER_TIMEOUT_MS).emitWithAck('fleet:unregister');
				} catch (error) {
					console.error(`Fleet unregister request to node ${nodeId} failed:`, error?.message || error);
				}
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
