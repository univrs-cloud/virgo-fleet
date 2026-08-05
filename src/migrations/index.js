import { readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { sequelize } from '../database/index.js';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
// Fixed, arbitrary key. Two instances booting simultaneously must not both apply the same
// migration; whichever takes the lock second sees the ledger already filled in and does nothing.
const ADVISORY_LOCK_KEY = 4820193;

async function ensureLedger() {
	await sequelize.query(`
		CREATE TABLE IF NOT EXISTS "migrations" (
			"name" TEXT PRIMARY KEY,
			"appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`);
}

async function loadMigrations() {
	const entries = await readdir(MIGRATIONS_DIR);
	const files = entries.filter((entry) => /^\d{3}_.+\.js$/.test(entry)).sort();
	return Promise.all(files.map(async (file) => {
		const module = await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
		return { name: file.replace(/\.js$/, ''), up: module.default };
	}));
}

// Applies every migration not yet recorded in the ledger, in filename order. Must run before
// sequelize.sync(): sync only ever creates missing tables, so a schema change that renames one
// has to land first or sync will helpfully create an empty table alongside the populated original.
export async function runMigrations() {
	await ensureLedger();
	const migrations = await loadMigrations();

	// One transaction for the whole run: Postgres DDL is transactional, so a failure anywhere
	// leaves neither the schema changes nor the ledger rows behind and the next boot retries
	// cleanly. It also scopes the advisory lock, which is released when the transaction ends
	// (a session-level lock would be unreliable here — the pool may hand back a different
	// connection for the unlock than the one that took it).
	await sequelize.transaction(async (transaction) => {
		await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
			replacements: { key: ADVISORY_LOCK_KEY },
			transaction
		});

		const [rows] = await sequelize.query('SELECT "name" FROM "migrations"', { transaction });
		const applied = new Set(rows.map((row) => row.name));

		for (const migration of migrations) {
			if (applied.has(migration.name)) {
				continue;
			}
			await migration.up({ sequelize, transaction });
			await sequelize.query('INSERT INTO "migrations" ("name") VALUES (:name)', {
				replacements: { name: migration.name },
				transaction
			});
			console.log(`Migration applied: ${migration.name}`);
		}
	});
}
