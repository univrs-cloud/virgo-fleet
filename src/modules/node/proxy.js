import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';
import { disconnectNodeUser } from '../../utils/node_proxy.js';

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

/** Per-user accessible node lists differ, so a plain `nsp.emit` broadcast can't be used; re-run
 * `emitNodes` for each connected user socket instead. When `affectedUserIds` is provided, only the
 * users whose inventory actually changed are refreshed; otherwise every connected user is refreshed. */
const broadcastNodes = async (module, affectedUserIds) => {
	const targeted = Array.isArray(affectedUserIds) ? new Set(affectedUserIds) : null;
	for (const socket of module.nsp.sockets.values()) {
		if (socket.data?.role !== 'user' || !socket.isAuthenticated) {
			continue;
		}
		if (targeted && !targeted.has(socket.userId)) {
			continue;
		}
		await emitNodes(socket, module);
	}
};

const register = (module) => {
	module.eventEmitter.on('nodes:updated', (payload) => {
		broadcastNodes(module, payload?.userIds).catch((error) => {
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
				role: 'admin'
			});
			const affected = await DataService.listNodeMemberUserIds(nodeId);
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
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
			const revoked = await DataService.getUserByEmail(revokeEmail);
			// Captured before the revoke so the user losing access is still refreshed.
			const affected = await DataService.listNodeMemberUserIds(nodeId);
			await DataService.revokeNodeAccess({
				email: revokeEmail,
				nodeId
			});
			disconnectNodeUser(nodeId, revoked?.id);
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
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
				// Members captured before the revoke so the departing admin is still refreshed.
				const affected = await DataService.listNodeMemberUserIds(nodeId);
				await DataService.revokeNodeAccess({ email: socket.email, nodeId });
				disconnectNodeUser(nodeId, socket.userId);
				module.eventEmitter.emit('nodes:updated', { userIds: affected });
				ack({ ok: true });
				return;
			}

			// The owner tears the node down: ask an online node to unregister (wiping its
			// own fleet configuration) first, then clean up the fleet database regardless
			// of the outcome. Members captured before deletion so everyone who had access refreshes.
			const affected = await DataService.listNodeMemberUserIds(nodeId);
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
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
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
			const owner = await DataService.isNodeOwner(socket.userId, config.nodeId);
			const groupManager = await DataService.isGroupManager(socket.userId, config.groupId);
			if (!owner || !groupManager) {
				ack({ ok: false, error: 'Only the node owner and a group manager can share a node with a group' });
				return;
			}
			await DataService.grantGroupNodeAccess({
				groupId: config.groupId,
				nodeId: config.nodeId
			});
			// Sharing a node with a group changes the accessible-node list for the node's own
			// members and everyone in the group, so refresh exactly those users.
			const [nodeMembers, groupMembers] = await Promise.all([
				DataService.listNodeMemberUserIds(config.nodeId),
				DataService.listGroupMemberUserIds(config.groupId)
			]);
			const affected = [...new Set([...nodeMembers, ...groupMembers])];
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
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
