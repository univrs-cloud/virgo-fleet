export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		ALTER TABLE IF EXISTS "nodes"
		ADD COLUMN IF NOT EXISTS "domainName" VARCHAR(255)
	`, { transaction });
};
