// The credentials and webauthn_challenges tables are new, so sequelize.sync() creates them by
// itself. This column is not: sync() only ever creates missing tables and never alters an existing
// one, so a database that predates biometric sign-in would keep a users table without it.
//
// Both guards matter. IF EXISTS covers the fresh-database case — migrations run before sync, so
// there is no users table yet and sync will create it from the model with the column already in
// place. IF NOT EXISTS makes the statement a no-op if the column is somehow already there.
export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		ALTER TABLE IF EXISTS "users"
		ADD COLUMN IF NOT EXISTS "passkeyEnabled" BOOLEAN NOT NULL DEFAULT false
	`, { transaction });
};
