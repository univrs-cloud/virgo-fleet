import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ensureNodeProxy, removeNodeProxy } from '../../utils/node_proxy.js';
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

	isNodeOnline(nodeId) {
		return nodeSocketsByNodeId.has(nodeId);
	}
}

export default () => {
	return new NodeModule();
};
