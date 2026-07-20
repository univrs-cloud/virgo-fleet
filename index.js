#!/usr/bin/env node

// Load .env before anything reads process.env (SMTP + APP_URL for email verification). In the
// container these come from real environment variables and .env is simply absent.
import 'dotenv/config';
import config from './config.js';
import createApp from './src/app.js';
import createServer from './src/server.js';
import * as socket from './src/socket.js';
import DataService from './src/services/data_service.js';
import PushService from './src/services/push.js';
import modules from './src/modules/index.js';

async function main() {
	const app = createApp();
	const server = createServer(app);
	socket.initializeSocket(server);
	await DataService.initialize();
	PushService.initialize();
	await modules();

	server.listen(config.server.port, () => {
		console.log(`Server started at http://${config.server.host}:${config.server.port}`);
	});
}

main().catch((error) => {
	console.error('Failed to start server:', error);
	process.exit(1);
});
