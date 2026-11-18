export default async function ({ sequelize, transaction }) {
	await sequelize.query('ALTER TABLE IF EXISTS "users" ADD COLUMN IF NOT EXISTS "biometricEnabled" BOOLEAN NOT NULL DEFAULT false', { transaction });
}
