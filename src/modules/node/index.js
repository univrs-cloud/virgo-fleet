import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerFleetProxy, disconnectNodeClients } from '../../utils/node_proxy.js';
import { registerNodeSocketGetter, attachNodeAssetHandler } from '../../utils/node_assets.js';
import eventEmitter from '../../utils/event_emitter.js';
import * as socket from '../../socket.js';
import DataService from '../../database/data_service.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';
import { emitNodes } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeSocketsByNodeId = new Map();

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
				DataService.touchNodeLastSeen(socket.data.nodeId).then(async () => {
					const userIds = await DataService.listNodeMemberUserIds(socket.data.nodeId);
					this.eventEmitter.emit('nodes:updated', { userIds });
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
					disconnectNodeClients(nodeId);
					this.#broadcastNodeStatus(nodeId, false);
					DataService.touchNodeLastSeen(nodeId).then(async () => {
						const userIds = await DataService.listNodeMemberUserIds(nodeId);
						this.eventEmitter.emit('nodes:updated', { userIds });
					});
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

	async #broadcastNodeStatus(nodeId, online) {
		try {
			const memberIds = new Set(await DataService.listNodeMemberUserIds(nodeId));
			for (const socket of this.#nsp.sockets.values()) {
				if (socket.data?.role === 'user' && socket.isAuthenticated && memberIds.has(socket.userId)) {
					socket.emit('node:status', { nodeId, online });
				}
			}
		} catch (error) {
			console.error('Error broadcasting node status:', error);
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
		this.#broadcastNodeStatus(nodeId, true);
	}

	isNodeOnline(nodeId) {
		return nodeSocketsByNodeId.has(nodeId);
	}
}

export default () => {
	return new NodeModule();
};
