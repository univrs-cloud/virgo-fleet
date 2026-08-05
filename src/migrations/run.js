#!/usr/bin/env node

// Migration step of container startup, run by docker-entrypoint.sh before the app process starts.
// Exits non-zero on failure so the entrypoint's `set -e` aborts and the app never comes up against
// a schema it does not match. Also usable directly (`node src/migrations/run.js`) to migrate a
// database without starting the server — e.g. verifying against a restored dump.
import 'dotenv/config';
import { sequelize } from '../database/index.js';
import { runMigrations } from './index.js';

try {
	await runMigrations();
	console.log('Migrations complete.');
} catch (error) {
	console.error('Migrations failed:', error);
	// Set rather than process.exit() so the connection below still closes cleanly.
	process.exitCode = 1;
} finally {
	await sequelize.close();
}
