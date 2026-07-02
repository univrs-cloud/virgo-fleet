import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ensureNodeProxy, removeNodeProxy } from './node_proxy.js';
import eventEmitter from '../../utils/event_emitter.js';
import * as socket from '../../socket.js';
import DataService from '../../database/data_service.js';
import { authenticateSocketUser } from '../../utils/socket_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeSocketsByNodeId = new Map();
const pendingRequests = new Map();

class NodeModule {
	#nsp;
	#plugins = [];
	#interval = null;

	constructor() {
		this.#nsp = socket.getIO().of('/node');
		this.#setupMiddleware();
		this.#setupConnectionHandlers();
		setImmediate(() => {
			this.#loadPlugins();
		});
		this.#interval = setInterval(() => {
			this.#cleanupPendingRequests();
		}, 5000);
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
					removeNodeProxy(nodeId);
					this.#broadcastNodeStatus(nodeId, false);
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

	#cleanupPendingRequests() {
		const now = Date.now();
		for (const [requestId, entry] of pendingRequests) {
			if ((now - entry.createdAt) > 30000) {
				pendingRequests.delete(requestId);
				entry.userSocket.emit('host:res', {
					requestId,
					nodeId: entry.nodeId,
					ok: false,
					error: 'Timed out waiting for node response'
				});
			}
		}
	}

	#broadcastNodeStatus(nodeId, online) {
		for (const socket of this.#nsp.sockets.values()) {
			if (socket.data?.role === 'user' && socket.isAuthenticated) {
				socket.emit('nodes:status', { nodeId, online });
			}
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
		ensureNodeProxy(nodeId, (id) => {
			return nodeSocketsByNodeId.get(id);
		});
		this.#broadcastNodeStatus(nodeId, true);
	}

	addPendingRequest(requestId, entry) {
		pendingRequests.set(requestId, entry);
	}

	resolvePendingRequest(requestId, payload) {
		const pending = pendingRequests.get(requestId);
		if (!pending) {
			return;
		}
		pendingRequests.delete(requestId);
		pending.userSocket.emit('host:res', {
			requestId,
			nodeId: pending.nodeId,
			ok: true,
			result: payload.result ?? null,
			error: payload.error ?? null
		});
	}

	isNodeOnline(nodeId) {
		return nodeSocketsByNodeId.has(nodeId);
	}
}

export default () => {
	return new NodeModule();
};
