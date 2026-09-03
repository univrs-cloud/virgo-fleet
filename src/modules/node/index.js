import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerFleetProxy, disconnectNodeClients } from '../../utils/node_proxy.js';
import { registerNodeSocketGetter, attachNodeAssetHandler, failPendingRequestsForNode } from '../../utils/node_assets.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';
import eventEmitter from '../../utils/event_emitter.js';
import { emitNodes } from './proxy.js';
import * as socket from '../../socket.js';
import PushService from '../../services/push.js';
import DataService from '../../services/data_service.js';
import DomainService from '../../services/domain_service.js';
import { getSocketClientAddress } from '../../utils/socket_rate_limit.js';

const UNREGISTER_TIMEOUT_MS = 5000;
// How often stale connectivity events (beyond the retention window) are swept.
const CONNECTIVITY_PRUNE_INTERVAL_MS = 1000 * 60 * 60;
const UPDATE_STAGES = new Set(['download', 'install']);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

class NodeModule {
	#nsp;
	#plugins = [];
	#nodeSocketsByNodeId = new Map();
	#updatesByNodeId = new Map();
	#updateByNodeId = new Map();
	#appUpdateJobsByNodeId = new Map();
	#storageByNodeId = new Map();
	#upsByNodeId = new Map();
	#peersByNodeId = new Map();

	constructor() {
		this.#nsp = socket.getIO().of('/node');
		registerFleetProxy(socket.getIO(), (nodeId) => {
			return this.#nodeSocketsByNodeId.get(nodeId);
		});
		registerNodeSocketGetter((nodeId) => {
			return this.#nodeSocketsByNodeId.get(nodeId);
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

	setNodeSocket(nodeId, socket) {
		this.#nodeSocketsByNodeId.set(nodeId, socket);
		attachNodeAssetHandler(socket);
	}

	getNodeSocket(nodeId) {
		return this.#nodeSocketsByNodeId.get(nodeId);
	}
	
	disconnectNode(nodeId) {
		this.getNodeSocket(nodeId)?.disconnect(true);
	}

	isNodeOnline(nodeId) {
		return this.#nodeSocketsByNodeId.has(nodeId);
	}

	getNodeUpdates(nodeId) {
		return this.#updatesByNodeId.get(nodeId) ?? null;
	}

	getNodeUpdate(nodeId) {
		return this.#updateByNodeId.get(nodeId) ?? null;
	}

	getNodeAppUpdateJobs(nodeId) {
		return this.#appUpdateJobsByNodeId.get(nodeId) ?? [];
	}

	getNodeStorage(nodeId) {
		return this.#storageByNodeId.get(nodeId) ?? null;
	}

	getNodeUps(nodeId) {
		return this.#upsByNodeId.get(nodeId) ?? null;
	}

	/** The other node ids this node reports having adopted/been adopted by. Raw as the node sent it —
	 * not yet filtered to ids the caller can actually see, which is the proxy layer's job. */
	getNodePeers(nodeId) {
		return this.#peersByNodeId.get(nodeId) ?? [];
	}

	/** Fully removes a node from the fleet: asks an online node to unregister (wiping its own fleet
	 * config) first, then deletes the fleet records and drops its connection. Remaining members are
	 * refreshed so it disappears from their inventory. Used by the owner "Remove from inventory". */
	async teardownNode(nodeId) {
		const affected = await DataService.listNodeMemberUserIds(nodeId);
		await this.#requestUnregister(nodeId);
		await DomainService.release(nodeId);
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
				DomainService.reprobe(socket.data.nodeId, getSocketClientAddress(socket))
					.catch((error) => { console.error(`[domains] reprobe failed for ${socket.data.nodeId}: ${error.message}`); });
				socket.on('node:updates', ({ system, apps } = {}) => {
					this.#updatesByNodeId.set(socket.data.nodeId, { system, apps });
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node updates:', error); });
					this.#notifyUpdatesAvailable(socket.data.nodeId, { system, apps })
						.catch((error) => { console.error('Error pushing update notification:', error); });
				});
				socket.on('node:update', (update) => {
					const sanitized = this.#sanitizeUpdate(update);
					if (sanitized) {
						this.#updateByNodeId.set(socket.data.nodeId, sanitized);
					} else {
						this.#updateByNodeId.delete(socket.data.nodeId);
					}
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node update progress:', error); });
				});
				socket.on('node:app:update:job', (job) => {
					if (!job?.id) {
						return;
					}

					const jobs = this.#appUpdateJobsByNodeId.get(socket.data.nodeId) ?? [];
					this.#appUpdateJobsByNodeId.set(socket.data.nodeId, this.#applyAppUpdateJob(jobs, job));
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node app update jobs:', error); });
				});
				socket.on('node:storage', (storage) => {
					this.#storageByNodeId.set(socket.data.nodeId, storage);
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node storage:', error); });
					this.#notifyStorageHealth(socket.data.nodeId, storage)
						.catch((error) => { console.error('Error pushing storage notification:', error); });
				});
				socket.on('node:ups', (ups) => {
					const changed = (this.#upsSignature(this.#upsByNodeId.get(socket.data.nodeId)) !== this.#upsSignature(ups));
					this.#upsByNodeId.set(socket.data.nodeId, ups);
					if (!changed) {
						return;
					}

					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node ups:', error); });
				});
				socket.on('node:peers', (peers) => {
					this.#peersByNodeId.set(socket.data.nodeId, Array.isArray(peers) ? peers : []);
					DataService.listNodeMemberUserIds(socket.data.nodeId)
						.then((userIds) => { this.eventEmitter.emit('nodes:updated', { userIds }); })
						.catch((error) => { console.error('Error broadcasting node peers:', error); });
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
				if (nodeId && this.#nodeSocketsByNodeId.get(nodeId) === socket) {
					this.#nodeSocketsByNodeId.delete(nodeId);
					this.#updatesByNodeId.delete(nodeId);
					this.#updateByNodeId.delete(nodeId);
					this.#appUpdateJobsByNodeId.delete(nodeId);
					this.#storageByNodeId.delete(nodeId);
					this.#upsByNodeId.delete(nodeId);
					this.#peersByNodeId.delete(nodeId);
					disconnectNodeClients(nodeId);
					// Node's gone: release any in-flight asset requests (and their buffers) now rather
					// than waiting for their timeouts. Runs after the map delete so the abort emit no-ops.
					failPendingRequestsForNode(nodeId);
					this.#handleNodePresence(nodeId, false);
				}
			});
		});
	}

	/** What the node card draws from a UPS reading: the power source, whether it is charging, and the
	 * whole-percent capacity. */
	#upsSignature(ups) {
		if (!ups || typeof ups !== 'object') {
			return String(ups);
		}

		return `${ups.powerSource}:${ups.isCharging}:${Math.round(ups.capacity ?? 0)}`;
	}

	/** The shape of a node's system update the fleet is willing to show: anything it can't read as a
	 * stage and a percent degrades to the bare state. */
	#sanitizeUpdate(update) {
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
	}

	/** A node's app update jobs after applying one it just reported, keeping the list the way a browser
	 * does: replace it by id, or drop it once it reads as finished. */
	#applyAppUpdateJob(jobs, job) {
		const remaining = jobs.filter((tracked) => { return tracked.id !== job.id; });
		return ['completed', 'failed'].includes(job.progress?.state) ? remaining : [...remaining, job];
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

	/** What a node currently has waiting, as a list of things rather than a count: a package at the
	 * version it can move to, an app by name. Working through them changes the list without any of it
	 * being news, which is the difference between this and a count.
	 *
	 * A node reports each side as a list once it knows, and as `false` until it does — after a restart,
	 * before the first check. An unknown side keeps whatever was last known of it, so a node coming back
	 * does not appear to have everything all over again. */
	#updateKeys({ system, apps }, previous) {
		const known = (prefix) => { return previous.filter((key) => { return key.startsWith(prefix); }); };
		return [
			...(Array.isArray(system) ? system.map((update) => { return `system:${update?.package}@${update?.version?.updatableTo}`; }) : known('system:')),
			...(Array.isArray(apps) ? apps.map((app) => { return `app:${app?.name}`; }) : known('app:'))
		].sort();
	}

	/** The members of a node with nothing to look at right now. Someone with the fleet open is watching
	 * the same updates arrive on screen, and a notification tells them what they can already see. */
	#membersAway(userIds) {
		const watching = new Set();
		for (const socket of this.#nsp.sockets.values()) {
			if (socket.data?.role === 'user' && socket.isAuthenticated) {
				watching.add(socket.userId);
			}
		}
		return userIds.filter((userId) => { return !watching.has(userId); });
	}

	/** Web Push to a node's members when something appears that was not waiting before. The list is
	 * persisted on the node row, so a node re-reporting on every reconnect, a restart of this process, or
	 * updates being worked through one at a time all pass in silence — only an addition is news. The
	 * stored list is refreshed either way, so an update installed now and offered again later counts as
	 * new when it returns. */
	async #notifyUpdatesAvailable(nodeId, { system, apps }) {
		let previous = [];
		try {
			const stored = JSON.parse((await DataService.getNodeUpdateSignature(nodeId)) || '[]');
			previous = (Array.isArray(stored) ? stored : []);
		} catch (error) {
			// Written in an older shape, before this was a list: nothing to compare against.
		}

		const current = this.#updateKeys({ system, apps }, previous);
		const isNews = current.some((key) => { return !previous.includes(key); });
		await DataService.setNodeUpdateSignature(nodeId, JSON.stringify(current));
		if (!isNews) {
			return;
		}

		const [name, userIds] = await Promise.all([
			DataService.getNodeName(nodeId),
			DataService.listNodeMemberUserIds(nodeId)
		]);
		const recipients = this.#membersAway(userIds);
		if (recipients.length === 0) {
			return;
		}

		await PushService.sendNodeUpdateNotification(recipients, {
			nodeId,
			name,
			systemCount: (Array.isArray(system) ? system.length : 0),
			appsCount: (Array.isArray(apps) ? apps.length : 0)
		});
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

	/** Best-effort request to an online node to wipe its own fleet config. */
	async #requestUnregister(nodeId) {
		const nodeSocket = this.getNodeSocket(nodeId);
		if (!nodeSocket?.connected) {
			return;
		}
		try {
			await nodeSocket.timeout(UNREGISTER_TIMEOUT_MS).emitWithAck('fleet:unregister');
		} catch (error) {
			console.error(`Fleet unregister request to node ${nodeId} failed:`, error?.message || error);
		}
	}
}

export default () => {
	return new NodeModule();
};
