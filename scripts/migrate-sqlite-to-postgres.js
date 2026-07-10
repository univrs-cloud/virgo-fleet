#!/usr/bin/env node
//
// One-time data migration: copies every row from the legacy SQLite database into the Postgres
// database configured via the app's DB_* environment variables. Run it once, with the fleet
// container stopped, then start the fleet on Postgres.
//
//   SQLITE_PATH=/messier/apps/fleet/data/virgo.db \
//   DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
//   node scripts/migrate-sqlite-to-postgres.js
//
// It creates the Postgres schema (sequelize.sync), copies tables in foreign-key-safe order inside
// a single transaction, realigns the id sequences, and verifies row counts. Re-running against a
// non-empty target is refused unless FORCE=true (a clean re-run means recreating the database).

import { pathToFileURL } from 'url';
import { Sequelize, QueryTypes } from 'sequelize';
import { sequelize } from '../src/database/index.js';
import {
	FleetUser,
	FleetGroup,
	Node,
	FleetSession,
	FleetPendingUser,
	FleetUserGroup,
	NodeAccess,
	GroupNodeAccess
} from '../src/database/models/associations.js';

const SQLITE_PATH = process.env.SQLITE_PATH || '/data/virgo.db';
const FORCE = process.env.FORCE === 'true';

// Foreign-key-safe insert order: parents before the rows that reference them.
const TABLES = [
	{ model: FleetUser, table: 'fleet_users', bools: ['isDisabled'], dates: ['createdAt', 'updatedAt'] },
	{ model: FleetGroup, table: 'fleet_groups', bools: [], dates: ['createdAt', 'updatedAt'] },
	{ model: Node, table: 'nodes', bools: [], dates: ['lastSeenAt', 'createdAt', 'updatedAt'] },
	{ model: FleetSession, table: 'fleet_sessions', bools: [], dates: ['expiresAt', 'createdAt', 'updatedAt'] },
	{ model: FleetPendingUser, table: 'fleet_pending_users', bools: [], dates: ['expiresAt', 'createdAt', 'updatedAt'] },
	{ model: FleetUserGroup, table: 'fleet_user_groups', bools: [], dates: ['createdAt', 'updatedAt'] },
	{ model: NodeAccess, table: 'node_accesses', bools: [], dates: ['createdAt', 'updatedAt'] },
	{ model: GroupNodeAccess, table: 'group_node_accesses', bools: [], dates: ['createdAt', 'updatedAt'] }
];

// SQLite stores DATE as a string and BOOLEAN as 0/1; Postgres wants real Date/boolean values.
function toDate(value) {
	if (value === null || value === undefined) {
		return null;
	}
	if (value instanceof Date) {
		return value;
	}
	if (typeof value === 'number') {
		return new Date(value);
	}
	let text = String(value).trim();
	// Sequelize's SQLite DATE format is 'YYYY-MM-DD HH:mm:ss.SSS +00:00'; normalise to ISO 8601.
	if (/^\d{4}-\d{2}-\d{2} /.test(text)) {
		text = text.replace(' ', 'T').replace(/\s+/g, '');
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? new Date(value) : parsed;
}

function toBool(value) {
	return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

async function main() {
	const source = new Sequelize({ dialect: 'sqlite', storage: SQLITE_PATH, logging: false });

	try {
		await source.authenticate();
	} catch (error) {
		throw new Error(`Cannot open source SQLite at ${SQLITE_PATH}: ${error.message}`);
	}
	try {
		await sequelize.authenticate();
	} catch (error) {
		throw new Error(`Cannot reach target Postgres (check DB_* env): ${error.message}`);
	}

	// Same model definitions as the app, so this produces the identical schema on Postgres.
	await sequelize.sync();

	const existing = await FleetUser.count();
	if (existing > 0 && !FORCE) {
		throw new Error(`Target already has ${existing} fleet_users rows — refusing to import. `
			+ 'Recreate the database for a clean run, or set FORCE=true.');
	}

	await sequelize.transaction(async (transaction) => {
		for (const { model, table, bools, dates } of TABLES) {
			const rows = await source.query(`SELECT * FROM "${table}"`, { type: QueryTypes.SELECT });
			for (const row of rows) {
				for (const field of bools) {
					row[field] = toBool(row[field]);
				}
				for (const field of dates) {
					row[field] = toDate(row[field]);
				}
			}
			if (rows.length) {
				await model.bulkCreate(rows, { transaction, validate: false, hooks: false });
			}
			console.log(`copied ${table}: ${rows.length}`);
		}
	});

	// bulkCreate with explicit ids does not advance Postgres' SERIAL sequences, so realign each to
	// max(id). is_called=false when the table is empty so the next id is 1. Join tables with a
	// composite key (no serial id) return a null sequence and are skipped.
	for (const { table } of TABLES) {
		const [{ seq }] = await sequelize.query(
			`SELECT pg_get_serial_sequence('"${table}"', 'id') AS seq`,
			{ type: QueryTypes.SELECT }
		);
		if (!seq) {
			continue;
		}
		await sequelize.query(
			`SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM "${table}"), 1), (SELECT COUNT(*) FROM "${table}") > 0)`
		);
	}

	let mismatch = false;
	for (const { model, table } of TABLES) {
		const [srcCount] = await source.query(`SELECT COUNT(*) AS c FROM "${table}"`, { type: QueryTypes.SELECT });
		const dstCount = await model.count();
		const ok = Number(srcCount.c) === dstCount;
		mismatch = mismatch || !ok;
		console.log(`${ok ? 'OK      ' : 'MISMATCH'}  ${table}: sqlite=${srcCount.c} postgres=${dstCount}`);
	}

	await source.close();
	await sequelize.close();

	if (mismatch) {
		throw new Error('Row counts do not match; see MISMATCH lines above.');
	}
	console.log('Migration complete.');
}

// Only run when invoked directly (`node scripts/migrate-...js`), so the helpers can be imported
// and unit-tested without kicking off a live migration.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main().catch((error) => {
		console.error('Migration failed:', error.message);
		process.exit(1);
	});
}

export { toDate, toBool };
