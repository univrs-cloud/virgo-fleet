export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		ALTER TABLE IF EXISTS "cluster_members"
		ADD COLUMN IF NOT EXISTS "lanIp" VARCHAR(255),
		ADD COLUMN IF NOT EXISTS "recordIds" JSONB NOT NULL DEFAULT '{}'
	`, { transaction });
};
