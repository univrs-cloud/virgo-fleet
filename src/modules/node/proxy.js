import { randomUUID } from 'crypto';
import DataService from '../../database/data_service.js';
import { normalizeEmail } from '../../utils/email.js';
import { buildConnectivitySegments } from '../../utils/connectivity.js';
import { disconnectNodeUser, revokeStaleNodeAccess } from '../../utils/node_proxy.js';

const CONNECTIVITY_WINDOW_MS = 1000 * 60 * 60 * 24;
// How long to wait for a node to bring the proxied namespace online before giving up.
const NODE_RELAY_TIMEOUT_MS = 8000;

/** Delivers a single event into one of an online node's own namespaces (e.g. host:update on /host) by
 * driving its existing control-socket proxy — the same path a browser uses to reach a node page, so
 * no node-side change is needed. Opens a proxy session to `namespace`, waits for the node's first
 * event back on it (proof its internal socket has connected — the node drops relayed events until
 * then), delivers `event` (with optional `config`, forwarded as the event's argument), then closes
 * the session. Generic on purpose: reaching a different subsystem later (e.g. app updates) is a
 * different namespace/event/config, not another copy of this. */
const relayEventToNode = (nodeSocket, { namespace, event, config }) => {
	return new Promise((resolve, reject) => {
		const sessionId = randomUUID();
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			nodeSocket.off('proxy:event', onEvent);
			nodeSocket.off('proxy:close', onClose);
		};
		const onEvent = (payload = {}) => {
			if (payload.sessionId !== sessionId || settled) {
				return;
			}
			settled = true;
			cleanup();
			nodeSocket.emit('proxy:event', { sessionId, event, args: config === undefined ? [] : [config] });
			// Let the event flush before tearing the session down.
			setTimeout(() => { nodeSocket.emit('proxy:close', { sessionId }); }, 1000);
			resolve();
		};
		const onClose = (payload = {}) => {
			if (payload.sessionId !== sessionId || settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(new Error('Node closed the proxy session.'));
		};
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			nodeSocket.emit('proxy:close', { sessionId });
			reject(new Error('Timed out reaching node.'));
		}, NODE_RELAY_TIMEOUT_MS);
		nodeSocket.on('proxy:event', onEvent);
		nodeSocket.on('proxy:close', onClose);
		nodeSocket.emit('proxy:open', { sessionId, namespace, user: { groups: ['admins'] } });
	});
};

const emitNodes = async (socket, module) => {
	try {
		if (!socket.isAuthenticated) {
			return;
		}
		const nodes = await DataService.listAccessibleNodes(socket.userId);
		// One query for every accessible node's events, grouped in memory, so each node's 24h bar is
		// built without a per-node round-trip.
		const nowMs = Date.now();
		const windowStartMs = nowMs - CONNECTIVITY_WINDOW_MS;
		const eventsByNodeId = new Map();
		for (const event of await DataService.getConnectivityEvents(nodes.map((node) => { return node.nodeId; }))) {
			if (!eventsByNodeId.has(event.nodeId)) {
				eventsByNodeId.set(event.nodeId, []);
			}
			eventsByNodeId.get(event.nodeId).push(event);
		}
		const inventory = await Promise.all(nodes.map(async (node) => {
			const online = module.isNodeOnline(node.nodeId);
			const entry = {
				...node,
				online,
				updates: module.getNodeUpdates(node.nodeId),
				update: module.getNodeUpdate(node.nodeId),
				connectivity: buildConnectivitySegments({
					events: eventsByNodeId.get(node.nodeId) || [],
					windowStartMs,
					nowMs,
					liveOnline: online
				})
			};
			if (node.isOwner) {
				const members = await DataService.listNodeMembers(node.nodeId);
				// Direct invites only; groups the node is shared with go in their own key so the owner
				// can tell them apart and revoke each with the right action (node:revoke vs
				// group:node:remove).
				entry.admins = (members.users || [])
					.filter((user) => { return user.role !== 'owner'; })
					.map((user) => { return { email: user.email, displayName: user.displayName }; });
				entry.groups = (members.groups || []).map((group) => { return { id: group.id, name: group.name }; });
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
	const recipients = [];
	for (const socket of module.nsp.sockets.values()) {
		if (socket.data?.role !== 'user' || !socket.isAuthenticated) {
			continue;
		}
		if (targeted && !targeted.has(socket.userId)) {
			continue;
		}
		recipients.push(socket);
	}
	// Fan out concurrently rather than one round-trip at a time: an untargeted refresh (e.g. a user
	// deletion) otherwise serializes into one emitNodes per connected user, and each emitNodes is
	// several queries — hundreds of sequential round-trips that freeze the broadcast. emitNodes
	// swallows its own errors, and the Sequelize pool caps how many queries actually run at once.
	await Promise.all(recipients.map((socket) => emitNodes(socket, module)));
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
				ack({ status: 'failed', message: 'Authentication required.' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			const inviteEmail = normalizeEmail(config?.email);
			if (!nodeId || !inviteEmail) {
				ack({ status: 'failed', message: 'nodeId and email are required.' });
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner) {
				ack({ status: 'failed', message: 'Only owner can invite users.' });
				return;
			}
			const invitee = await DataService.getUserByEmail(inviteEmail);
			if (!invitee) {
				ack({ status: 'failed', message: 'No account exists for that email address.' });
				return;
			}
			if (await DataService.isNodeOwner(invitee.id, nodeId)) {
				ack({ status: 'failed', message: 'The node owner already has access.' });
				return;
			}
			// One lookup tells us both whether they already have access and how (direct vs a group
			// share), so the message can point the owner at the right fix instead of a generic refusal.
			const existingAccess = (await DataService.listAccessibleNodes(invitee.id))
				.find((accessibleNode) => { return accessibleNode.nodeId === nodeId; });
			if (existingAccess) {
				ack({
					status: 'failed',
					message: existingAccess.access === 'group'
						? 'This account already has access to this node through a group it belongs to. Revoke the group’s access to this node instead of inviting directly.'
						: 'This account already has access.'
				});
				return;
			}
			await DataService.grantNodeAccess({
				email: inviteEmail,
				nodeId,
				role: 'admin'
			});
			const affected = await DataService.listNodeMemberUserIds(nodeId);
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('node:revoke', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ status: 'failed', message: 'Authentication required.' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			const revokeEmail = normalizeEmail(config?.email);
			if (!nodeId || !revokeEmail) {
				ack({ status: 'failed', message: 'nodeId and email are required.' });
				return;
			}
			const isSelf = socket.email === revokeEmail;
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner && !isSelf) {
				ack({ status: 'failed', message: 'Only the owner or the account itself can manage node access.' });
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
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('node:delete', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ status: 'failed', message: 'Authentication required.' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			if (!nodeId) {
				ack({ status: 'failed', message: 'nodeId is required.' });
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, nodeId);
			if (!owner) {
				const allowed = await DataService.canUserAccessNode(socket.userId, nodeId);
				if (!allowed) {
					ack({ status: 'failed', message: 'Access denied for node.' });
					return;
				}
				// An invited admin only detaches their own access; the node itself is untouched.
				// Members captured before the revoke so the departing admin is still refreshed.
				const affected = await DataService.listNodeMemberUserIds(nodeId);
				await DataService.revokeNodeAccess({ email: socket.email, nodeId });
				disconnectNodeUser(nodeId, socket.userId);
				module.eventEmitter.emit('nodes:updated', { userIds: affected });
				ack({ status: 'succeeded' });
				return;
			}

			// The owner tears the node down: unregister an online node (wiping its own fleet
			// config) then remove the fleet records and refresh the remaining members.
			await module.teardownNode(nodeId);
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('node:update', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				ack({ status: 'failed', message: 'Authentication required.' });
				return;
			}
			const nodeId = String(config?.nodeId || '').trim();
			if (!nodeId) {
				ack({ status: 'failed', message: 'nodeId is required.' });
				return;
			}
			const allowed = await DataService.canUserAccessNode(socket.userId, nodeId);
			if (!allowed) {
				ack({ status: 'failed', message: 'Access denied for node.' });
				return;
			}
			const nodeSocket = module.getNodeSocket(nodeId);
			if (!nodeSocket?.connected) {
				ack({ status: 'failed', message: 'Node is offline.' });
				return;
			}
			await relayEventToNode(nodeSocket, { namespace: '/host', event: 'host:update' });
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
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
				ack({ status: 'failed', message: 'Only the node owner and a group manager can share a node with a group.' });
				return;
			}
			await DataService.grantGroupNodeAccess({
				groupId: config.groupId,
				nodeId: config.nodeId
			});
			// A direct admin who is also in this group now has redundant access; collapse their direct
			// grant into the group so access is represented once. Admins not in the group keep theirs.
			await DataService.collapseDirectAdminsIntoGroup(config.nodeId, config.groupId);
			// Sharing a node with a group changes the accessible-node list for the node's own
			// members and everyone in the group, so refresh exactly those users.
			const [nodeMembers, groupMembers] = await Promise.all([
				DataService.listNodeMemberUserIds(config.nodeId),
				DataService.listGroupMemberUserIds(config.groupId)
			]);
			const affected = [...new Set([...nodeMembers, ...groupMembers])];
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('group:node:remove', async (config, ack = () => {}) => {
		try {
			if (!socket.isAuthenticated) {
				return;
			}
			const owner = await DataService.isNodeOwner(socket.userId, config.nodeId);
			const groupManager = await DataService.isGroupManager(socket.userId, config.groupId);
			// Either stakeholder can un-share: the node owner (it's their node) or a group manager
			// (it's their group). Sharing needs both, but removal shouldn't require the counterparty.
			if (!owner && !groupManager) {
				ack({ status: 'failed', message: 'Only the node owner or a group manager can un-share a node from a group.' });
				return;
			}
			// Capture the group's members before removing the share, then enforce: members who lose
			// their only path to the node have their live proxy sessions torn down (access is
			// otherwise only checked at connect) and their inventory refreshed so the node disappears.
			const groupMembers = await DataService.listGroupMemberUserIds(config.groupId);
			await DataService.revokeGroupNodeAccess({
				groupId: config.groupId,
				nodeId: config.nodeId
			});
			await revokeStaleNodeAccess(groupMembers, [config.nodeId]);
			const nodeMembers = await DataService.listNodeMemberUserIds(config.nodeId);
			const affected = [...new Set([...nodeMembers, ...groupMembers])];
			module.eventEmitter.emit('groups:updated');
			module.eventEmitter.emit('nodes:updated', { userIds: affected });
			ack({ status: 'succeeded' });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
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
