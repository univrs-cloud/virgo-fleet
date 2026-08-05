// Drops the fleet prefix from the schema: table names (fleet_users -> users) and the join columns
// that carried it (fleetUserId -> userId, fleetGroupId -> groupId). The prefix came from the old
// model names (FleetUser, FleetGroup, since renamed to User/Group) rather than from any schema
// need — these tables live alone in a dedicated `fleet` database, so it restated what the database
// name already said. The names that never carried it are left alone: the node_* tables, and the
// nodeId / ownerUserId / createdByUserId columns.
//
// Renaming a table or column in Postgres renames nothing else, so the sequences, constraints,
// indexes and enum types built on them keep their original names and are rewritten in the same
// pass — otherwise `users` would still be sitting on fleet_users_pkey and fleet_users_id_seq,
// exactly the inconsistency this migration exists to remove.
const TABLES = [
	['fleet_groups', 'groups'],
	['fleet_pending_users', 'pending_users'],
	['fleet_push_subscriptions', 'push_subscriptions'],
	['fleet_recovery_codes', 'recovery_codes'],
	['fleet_sessions', 'sessions'],
	['fleet_user_groups', 'user_groups'],
	['fleet_users', 'users']
];

// Matches an object name carrying the prefix in either position, and strips both in one step — a
// single constraint can hold both at once (fleet_sessions_fleetUserId_fkey).
const carriesPrefix = (column) => {
	return `(${column} LIKE 'fleet\\_%' OR ${column} LIKE '%fleetUserId%' OR ${column} LIKE '%fleetGroupId%')`;
};
const stripPrefix = (column) => {
	return `replace(replace(regexp_replace(${column}, '^fleet_', ''), 'fleetUserId', 'userId'), 'fleetGroupId', 'groupId')`;
};

export default async function up({ sequelize, transaction }) {
	for (const [from, to] of TABLES) {
		await sequelize.query(`
			DO $$
			BEGIN
				IF to_regclass('${from}') IS NOT NULL AND to_regclass('${to}') IS NULL THEN
					ALTER TABLE "${from}" RENAME TO "${to}";
				END IF;
			END $$;
		`, { transaction });
	}

	await sequelize.query(`
		DO $$
		DECLARE
			entry RECORD;
			target_schema NAME;
		BEGIN
			-- Resolve the schema from a table we just renamed rather than assuming public or trusting
			-- current_schema() (which is only the first search_path entry, while the renames above
			-- resolve against the whole path). NULL on a fresh database, where sync() creates
			-- everything already named correctly and every loop below matches nothing.
			SELECT namespace.nspname INTO target_schema
			FROM pg_class table_class
			JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
			WHERE table_class.oid = to_regclass('users');

			FOR entry IN
				SELECT columns.table_name, columns.column_name
				FROM information_schema.columns columns
				WHERE columns.table_schema::name = target_schema
				  AND columns.column_name IN ('fleetUserId', 'fleetGroupId')
			LOOP
				EXECUTE format(
					'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
					target_schema, entry.table_name, entry.column_name,
					CASE entry.column_name WHEN 'fleetUserId' THEN 'userId' ELSE 'groupId' END
				);
			END LOOP;

			-- Primary keys, unique constraints and foreign keys. Renaming a constraint also renames
			-- the index backing it, so these must be handled before the loose-index pass below.
			FOR entry IN
				SELECT namespace.nspname, table_class.relname, constraint_class.conname
				FROM pg_constraint constraint_class
				JOIN pg_class table_class ON table_class.oid = constraint_class.conrelid
				JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
				WHERE namespace.nspname = target_schema AND ${carriesPrefix('constraint_class.conname')}
			LOOP
				EXECUTE format(
					'ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
					entry.nspname, entry.relname, entry.conname, ${stripPrefix('entry.conname')}
				);
			END LOOP;

			-- Indexes that stand on their own (not backing a constraint).
			FOR entry IN
				SELECT namespace.nspname, index_class.relname
				FROM pg_class index_class
				JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
				WHERE namespace.nspname = target_schema
				  AND index_class.relkind = 'i'
				  AND ${carriesPrefix('index_class.relname')}
				  AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = index_class.oid)
			LOOP
				EXECUTE format(
					'ALTER INDEX %I.%I RENAME TO %I',
					entry.nspname, entry.relname, ${stripPrefix('entry.relname')}
				);
			END LOOP;

			-- Identity sequences (fleet_users_id_seq and friends). Column defaults reference the
			-- sequence by OID, so renaming does not disturb nextval().
			FOR entry IN
				SELECT namespace.nspname, sequence_class.relname
				FROM pg_class sequence_class
				JOIN pg_namespace namespace ON namespace.oid = sequence_class.relnamespace
				WHERE namespace.nspname = target_schema
				  AND sequence_class.relkind = 'S'
				  AND ${carriesPrefix('sequence_class.relname')}
			LOOP
				EXECUTE format(
					'ALTER SEQUENCE %I.%I RENAME TO %I',
					entry.nspname, entry.relname, ${stripPrefix('entry.relname')}
				);
			END LOOP;

			-- Enum types sequelize derives from the table name (enum_fleet_user_groups_role).
			FOR entry IN
				SELECT namespace.nspname, type_entry.typname
				FROM pg_type type_entry
				JOIN pg_namespace namespace ON namespace.oid = type_entry.typnamespace
				WHERE namespace.nspname = target_schema
				  AND type_entry.typtype = 'e'
				  AND type_entry.typname LIKE 'enum\\_fleet\\_%'
			LOOP
				EXECUTE format(
					'ALTER TYPE %I.%I RENAME TO %I',
					entry.nspname, entry.typname, 'enum_' || substring(entry.typname from 12)
				);
			END LOOP;

			-- The one index named explicitly in a model, so it does not match the patterns above.
			IF to_regclass('ux_fleet_groups_creator_name') IS NOT NULL THEN
				ALTER INDEX "ux_fleet_groups_creator_name" RENAME TO "ux_groups_creator_name";
			END IF;
		END $$;
	`, { transaction });
}
