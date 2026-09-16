export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		ALTER TABLE IF EXISTS "nodes"
		ADD COLUMN IF NOT EXISTS "machineId" TEXT,
		ADD COLUMN IF NOT EXISTS "peers" JSONB
	`, { transaction });
};
