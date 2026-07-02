import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import eventEmitter from '../utils/event_emitter.js';
import * as socket from '../socket.js';
import { authenticateSocketUser } from '../utils/socket_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class BaseModule {
	#name;
	#io;
	#nsp;
	#eventEmitter;
	#state = {};
	#plugins = [];

	constructor(name) {
		this.#name = name;
		this.#io = socket.getIO();
		this.#nsp = this.#io.of(`/${this.#name}`);
		this.#eventEmitter = eventEmitter;

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
		return this.#eventEmitter;
	}

	getState(key) {
		return structuredClone(this.#state[key]);
	}

	setState(key, state) {
		this.#state[key] = state;
	}

	getPlugins() {
		return this.#plugins;
	}

	getPlugin(name) {
		return this.#plugins.find((plugin) => { return plugin.name === name; });
	}

	toArray(value) {
		return Array.isArray(value) ? value : [];
	}

	async #authenticateSocket(socket) {
		await authenticateSocketUser(socket);
	}

	#setupMiddleware() {
		this.#nsp.use(async (socket, next) => {
			try {
				await this.#authenticateSocket(socket);
				next();
			} catch (error) {
				next(error);
			}
		});
	}

	#setupConnectionHandlers() {
		this.#nsp.on('connection', (socket) => {
			if (typeof this.onConnection === 'function') {
				this.onConnection(socket);
			}
			this.#plugins.forEach((plugin) => {
				if (typeof plugin.onConnection === 'function') {
					plugin.onConnection(socket, this);
				}
			});

			socket.on('disconnect', () => {
				if (typeof this.onDisconnect === 'function') {
					this.onDisconnect(socket);
				}
				this.#plugins.forEach((plugin) => {
					if (typeof plugin.onDisconnect === 'function') {
						plugin.onDisconnect(socket, this);
					}
				});
			});
		});
	}

	async #loadPlugins() {
		const pluginDir = path.join(__dirname, this.#name);
		if (!fs.existsSync(pluginDir)) {
			return;
		}
		const pluginFiles = fs.readdirSync(pluginDir)?.filter((file) => { return file.endsWith('.js') && file !== 'index.js'; });
		for (const file of pluginFiles) {
			try {
				const module = await import(pathToFileURL(path.join(pluginDir, file)).href);
				const plugin = module.default;
				if (!plugin || typeof plugin !== 'object') {
					console.warn(`[${this.#name}] Invalid plugin in ${file}: not an object`);
					continue;
				}
				this.#plugins.push(plugin);
				if (typeof plugin.register === 'function') {
					plugin.register(this);
				}
			} catch (error) {
				console.error(`[${this.#name}] Failed to load plugin ${file}:`, error);
			}
		}
	}
}

export default BaseModule;
