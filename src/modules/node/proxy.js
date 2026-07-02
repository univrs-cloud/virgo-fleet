import { randomUUID } from 'crypto';
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

const onConnection = async (socket, module) => {
	if (socket.data?.role === 'node') {
		return;
	}

	await emitNodes(socket, module);

	socket.on('nodes:list', async (_config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ ok: false, error: 'Authentication required' });
				return;
			}
			const nodes = await DataService.listAccessibleNodes(socket.userId);
			ack({
				ok: true,
				nodes: nodes.map((node) => {
					return {
						...node,
						online: module.isNodeOnline(node.nodeId)
					};
				})
			});
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});

	socket.on('nodes:invite', async (config, ack = () => {}) => {
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
			if (!owner && !socket.isAdmin) {
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

	socket.on('nodes:revoke', async (config, ack = () => {}) => {
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
			if (!owner && !socket.isAdmin && !isSelf) {
				ack({ ok: false, error: 'Only the owner or the account itself can manage node access' });
				return;
			}
			// Owner protection is also enforced in DataService.revokeNodeAccess itself, so it
			// can't be bypassed by an admin, or by the owner trying to remove themselves.
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

	socket.on('nodes:delete', async (config, ack = () => {}) => {
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
			if (!owner && !socket.isAdmin) {
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
			if (!socket.isAuthenticated || !socket.isAdmin) {
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

	socket.on('host:req', async (config, ack = () => {}) => {
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
			const allowed = await DataService.canUserAccessNode(socket.userId, nodeId);
			if (!allowed) {
				ack({ ok: false, error: 'Access denied for node' });
				return;
			}
			const nodeSocket = module.getNodeSocket(nodeId);
			if (!nodeSocket) {
				ack({ ok: false, error: 'Node is offline' });
				return;
			}
			const requestId = String(config?.requestId || randomUUID());
			module.addPendingRequest(requestId, {
				userSocket: socket,
				nodeId,
				createdAt: Date.now()
			});
			nodeSocket.emit('host:req', {
				requestId,
				nodeId,
				action: config?.action || 'proxy',
				data: config?.data ?? null
			});
			ack({ ok: true, requestId });
		} catch (error) {
			ack({ ok: false, error: error.message });
		}
	});
};

export default {
	name: 'proxy',
	onConnection,
	register
};
