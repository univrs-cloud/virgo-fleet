export default async function ({ sequelize, transaction }) {
	await sequelize.query('ALTER TABLE IF EXISTS "credentials" RENAME TO "webauthn_credentials"', { transaction });
}
