import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerFleetProxy, disconnectNodeClients } from '../../utils/node_proxy.js';
import { registerNodeSocketGetter, attachNodeAssetHandler, failPendingRequestsForNode } from '../../utils/node_assets.js';
import eventEmitter from '../../utils/event_emitter.js';
import PushService from '../../services/push.js';
import * as socket from '../../socket.js';
import DataService from '../../services/data_service.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';
import { emitNodes } from './proxy.js';

const FLEET_UNREGISTER_TIMEOUT_MS = 5000;
// How often stale connectivity events (beyond the retention window) are swept.
const CONNECTIVITY_PRUNE_INTERVAL_MS = 1000 * 60 * 60;
const UPDATE_STAGES = new Set(['download', 'install']);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeSocketsByNodeId = new Map();
// Deleted on disconnect so an offline node shows no badge; refreshed on reconnect. Value is
// { system, apps }, each an updates array | [] | false.
const updatesByNodeId = new Map();
const updateByNodeId = new Map();
const storageByNodeId = new Map();

const sanitizeUpdate = (update) => {
	const state = update?.state;
	if (state === 'succeeded' || state === 'failed') {
		return { state };
	}
	if (state !== 'running') {
		return null;
	}

	const progress = update.progress;
	const percent = Number(progress?.percent);
	if (!progress || !UPDATE_STAGES.has(progress.stage) || !Number.isFinite(percent)) {
		return { state };
	}
	return { state, stage: progress.stage, percent: Math.min(100, Math.max(0, Math.round(percent))) };
};

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
		// Sweep connectivity history down to the retention window on a slow cadence; unref so it never
		// keeps the process alive. Run once up front to clear anything stale from a previous run.
		DataService.pruneConnectivityEvents().catch((error) => {
			console.error('Error pruning connectivity events:', error);
		});
		setInterval(() => {
			DataService.pruneConnectivityEvents().catch((error) => {
				console.error('Error pruning connectivity events:', error);
			});
		}, CONNECTIVITY_PRUNE_INTERVAL_MS).unref();
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
					this.#notifyUpdatesAvailable(socket.data.nodeId, { system, apps })
						.catch((error) => { console.error('Error pushing update notification:', error); });
				});
				socket.on('node:update', (update) => {
					const sanitized = sanitizeUpdate(update);
					if (sanitized) {
						updateByNodeId.set(socket.data.nodeId, sanitized);
					} else {
						updateByNodeId.delete(socket.data.nodeId);
					}
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node update progress:', error); });
				});
				socket.on('node:storage', (storage) => {
					storageByNodeId.set(socket.data.nodeId, storage);
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node storage:', error); });
					this.#notifyStorageHealth(socket.data.nodeId, storage)
						.catch((error) => { console.error('Error pushing storage notification:', error); });
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
					updateByNodeId.delete(nodeId);
					storageByNodeId.delete(nodeId);
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
		// Record the transition so the fleet grid can draw the node's 24h connectivity bar. Independent
		// of the lastSeen write and the fan-out below, so a failure here doesn't gate presence updates.
		DataService.recordConnectivityEvent(nodeId, online).catch((error) => {
			console.error('Error recording connectivity event:', error);
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

	/** Web Push to a node's members when its set of available updates changes. A signature persisted on
	 * the node row dedupes re-reports — a node re-sends node:updates on every reconnect, and the in-memory
	 * updatesByNodeId is cleared on disconnect — so members are notified once per new update set rather
	 * than on every reconnect or process restart. An empty set resets the stored signature (so the next
	 * time updates appear it counts as new) without notifying. */
	async #notifyUpdatesAvailable(nodeId, { system, apps }) {
		const systemCount = Array.isArray(system) ? system.length : 0;
		const appsCount = Array.isArray(apps) ? apps.length : 0;
		const signature = (systemCount + appsCount) === 0 ? '' : JSON.stringify({ system, apps });
		const previous = (await DataService.getNodeUpdateSignature(nodeId)) || '';
		if (signature === previous) {
			return;
		}

		await DataService.setNodeUpdateSignature(nodeId, signature);
		if (!signature) {
			return;
		}
		
		const [name, userIds] = await Promise.all([
			DataService.getNodeName(nodeId),
			DataService.listNodeMemberUserIds(nodeId)
		]);
		await PushService.sendNodeUpdateNotification(userIds, { nodeId, name, systemCount, appsCount });
	}

	/** The summarised state of a pool, mirroring the fleet grid: a resilvering pool reads as rebuilding
	 * (recovering) rather than the degraded health it reports underneath. */
	#poolState(pool) {
		const scan = pool.scanStats;
		if (scan?.function?.toLowerCase() === 'resilver' && scan?.state?.toLowerCase() !== 'finished') {
			return 'rebuilding';
		}
		const health = pool.properties?.health?.value?.toLowerCase();
		if (!health || health === 'online') {
			return 'online';
		}
		return health === 'degraded' ? 'degraded' : 'faulted';
	}

	/** Web Push to a node's members when a pool's health state changes. A signature of every pool's state
	 * is persisted on the node row so the node re-reporting the same storage (it re-sends node:storage on
	 * every poll) only notifies on an actual transition. Pools becoming/returning to online only notify
	 * when they were previously unhealthy, so a healthy baseline (or a freshly adopted healthy node) is
	 * silent while recoveries and regressions both surface. */
	async #notifyStorageHealth(nodeId, storage) {
		const pools = Array.isArray(storage) ? storage.filter((pool) => { return pool?.type?.toLowerCase() === 'pool'; }) : [];
		const current = {};
		for (const pool of pools) {
			current[pool.name] = this.#poolState(pool);
		}
		const signature = JSON.stringify(Object.keys(current).sort().map((name) => { return [name, current[name]]; }));
		const previous = await DataService.getNodeStorageSignature(nodeId);
		if (signature === previous) {
			return;
		}

		await DataService.setNodeStorageSignature(nodeId, signature);

		const prev = previous ? Object.fromEntries(JSON.parse(previous)) : {};
		const changes = [];
		for (const [pool, state] of Object.entries(current)) {
			const before = prev[pool];
			if (before === state) {
				continue;
			}
			// A pool arriving at / returning to online is only worth a push when it was previously unhealthy.
			if (state === 'online' && (before === undefined || before === 'online')) {
				continue;
			}
			changes.push({ pool, from: before, to: state });
		}
		if (!changes.length) {
			return;
		}

		const [name, userIds] = await Promise.all([
			DataService.getNodeName(nodeId),
			DataService.listNodeMemberUserIds(nodeId)
		]);
		await PushService.sendNodeStorageNotification(userIds, { nodeId, name, changes });
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

	getNodeUpdate(nodeId) {
		return updateByNodeId.get(nodeId) ?? null;
	}
	
	getNodeStorage(nodeId) {
		return storageByNodeId.get(nodeId) ?? null;
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
