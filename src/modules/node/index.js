import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerFleetProxy, disconnectNodeClients } from '../../utils/node_proxy.js';
import { registerNodeSocketGetter, attachNodeAssetHandler, failPendingRequestsForNode } from '../../utils/node_assets.js';
import eventEmitter from '../../utils/event_emitter.js';
import * as socket from '../../socket.js';
import DataService from '../../database/data_service.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';
import { emitNodes } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeSocketsByNodeId = new Map();
// Deleted on disconnect so an offline node shows no badge; refreshed on reconnect. Value is
// { system, apps }, each an updates array | [] | false.
const updatesByNodeId = new Map();
const FLEET_UNREGISTER_TIMEOUT_MS = 5000;

class NodeModule {
	#nsp;
	#plugins = [];

	constructor() {
		this.#nsp = socket.getIO().of('/node');
		registerFleetProxy(socket.getIO(), (nodeId) => {
			return nodeSocketsByNodeId.get(nodeId);
		});
		registerNodeSocketGetter((nodeId) => {
			return nodeSocketsByNodeId.get(nodeId);
		});
		this.#setupMiddleware();
		this.#setupConnectionHandlers();
		// A deleted user's owned nodes are cascade-removed from the DB; notify those nodes (captured
		// before deletion) to unregister and drop their sockets.
		eventEmitter.on('nodes:unregister', ({ nodeIds } = {}) => {
			this.unregisterNodes(nodeIds).catch((error) => {
				console.error('Error unregistering nodes:', error);
			});
		});
		setImmediate(() => {
			this.#loadPlugins();
		});
	}

	get nsp() {
		return this.#nsp;
	}

	get eventEmitter() {
		return eventEmitter;
	}

	#setupMiddleware() {
		this.#nsp.use(async (socket, next) => {
			try {
				if (socket.handshake?.auth?.role === 'node') {
					const secret = String(socket.handshake?.auth?.secret || '');
					if (secret) {
						const node = await DataService.getNodeByToken(secret);
						if (!node) {
							next(new Error('Node authentication failed'));
							return;
						}
						socket.data.role = 'node';
						socket.data.nodeId = node.nodeId;
						next();
						return;
					}
					socket.data.role = 'node';
					next();
					return;
				}

				await authenticateSocketUser(socket);
				if (!socket.isAuthenticated) {
					next(new Error('Authentication required'));
					return;
				}
				socket.data.role = 'user';
				next();
			} catch (error) {
				next(error);
			}
		});
	}

	#setupConnectionHandlers() {
		this.#nsp.on('connection', (socket) => {
			if (socket.data?.role === 'node' && socket.data?.nodeId) {
				this.setNodeSocket(socket.data.nodeId, socket);
				this.#handleNodePresence(socket.data.nodeId, true);
				socket.on('node:updates', ({ system, apps } = {}) => {
					updatesByNodeId.set(socket.data.nodeId, { system, apps });
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node updates:', error); });
				});
			}
			if (socket.data?.role === 'user' && socket.isAuthenticated) {
				emitNodes(socket, this).catch((error) => {
					console.error('Error emitting nodes:', error);
				});
			}
			this.#plugins.forEach((plugin) => {
				if (typeof plugin.onConnection === 'function') {
					plugin.onConnection(socket, this);
				}
			});
			socket.on('disconnect', () => {
				const nodeId = socket.data?.nodeId;
				if (nodeId && nodeSocketsByNodeId.get(nodeId) === socket) {
					nodeSocketsByNodeId.delete(nodeId);
					updatesByNodeId.delete(nodeId);
					disconnectNodeClients(nodeId);
					// Node's gone: release any in-flight asset requests (and their buffers) now rather
					// than waiting for their timeouts. Runs after the map delete so the abort emit no-ops.
					failPendingRequestsForNode(nodeId);
					this.#handleNodePresence(nodeId, false);
				}
			});
		});
	}

	async #loadPlugins() {
		const pluginDir = __dirname;
		const pluginFiles = fs.readdirSync(pluginDir)?.filter((file) => { return file.endsWith('.js') && file !== 'index.js'; });
		for (const file of pluginFiles) {
			try {
				const module = await import(pathToFileURL(path.join(pluginDir, file)).href);
				const plugin = module.default;
				if (!plugin || typeof plugin !== 'object') {
					console.warn(`[node] Invalid plugin in ${file}: not an object`);
					continue;
				}
				this.#plugins.push(plugin);
				if (typeof plugin.register === 'function') {
					plugin.register(this);
				}
			} catch (error) {
				console.error(`[node] Failed to load plugin ${file}:`, error);
			}
		}
	}

	/** A single membership lookup drives both the per-user node:status push and the nodes:updated
	 * refresh when a node comes online / goes offline — previously each connect and disconnect
	 * queried listNodeMemberUserIds twice for the same nodeId. touchNodeLastSeen is an independent
	 * write, so it runs alongside without gating the fan-out (and no longer risks an unhandled
	 * rejection, which the old detached .then() chain did). */
	async #handleNodePresence(nodeId, online) {
		DataService.touchNodeLastSeen(nodeId).catch((error) => {
			console.error('Error updating node last seen:', error);
		});
		try {
			const userIds = await DataService.listNodeMemberUserIds(nodeId);
			const memberIds = new Set(userIds);
			for (const socket of this.#nsp.sockets.values()) {
				if (socket.data?.role === 'user' && socket.isAuthenticated && memberIds.has(socket.userId)) {
					socket.emit('node:status', { nodeId, online });
				}
			}
			this.eventEmitter.emit('nodes:updated', { userIds });
		} catch (error) {
			console.error('Error broadcasting node presence:', error);
		}
	}

	getNodeSocket(nodeId) {
		return nodeSocketsByNodeId.get(nodeId);
	}

	/** Forcibly drops a node's live connection (e.g. after it's deleted); the socket's own `disconnect` handler does the rest of the cleanup (proxy teardown, status broadcast). */
	disconnectNode(nodeId) {
		this.getNodeSocket(nodeId)?.disconnect(true);
	}

	setNodeSocket(nodeId, socket) {
		nodeSocketsByNodeId.set(nodeId, socket);
		attachNodeAssetHandler(socket);
	}

	isNodeOnline(nodeId) {
		return nodeSocketsByNodeId.has(nodeId);
	}

	/** { system, apps } the node last reported, or null when offline/unknown. */
	getNodeUpdates(nodeId) {
		return updatesByNodeId.get(nodeId) ?? null;
	}

	/** Best-effort request to an online node to wipe its own fleet config. */
	async #requestUnregister(nodeId) {
		const nodeSocket = this.getNodeSocket(nodeId);
		if (!nodeSocket?.connected) {
			return;
		}
		try {
			await nodeSocket.timeout(FLEET_UNREGISTER_TIMEOUT_MS).emitWithAck('fleet:unregister');
		} catch (error) {
			console.error(`Fleet unregister request to node ${nodeId} failed:`, error?.message || error);
		}
	}

	/** Fully removes a node from the fleet: asks an online node to unregister (wiping its own fleet
	 * config) first, then deletes the fleet records and drops its connection. Remaining members are
	 * refreshed so it disappears from their inventory. Used by the owner "Remove from inventory". */
	async teardownNode(nodeId) {
		const affected = await DataService.listNodeMemberUserIds(nodeId);
		await this.#requestUnregister(nodeId);
		await DataService.deleteNode(nodeId);
		this.disconnectNode(nodeId);
		this.eventEmitter.emit('nodes:updated', { userIds: affected });
	}

	/** Notifies nodes to unregister and drops their sockets without touching the DB — used when the
	 * records were already removed (e.g. cascaded by deleting their owner's account). */
	async unregisterNodes(nodeIds) {
		for (const nodeId of nodeIds || []) {
			await this.#requestUnregister(nodeId);
			this.disconnectNode(nodeId);
		}
	}
}

export default () => {
	return new NodeModule();
};
