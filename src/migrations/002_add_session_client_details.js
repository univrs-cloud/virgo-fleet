// Same guards as 001. Every column is nullable: sessions created before this migration have no
// client details, and the profile renders those as unknown rather than inventing one.
export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		ALTER TABLE IF EXISTS "sessions"
		ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
		ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
		ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMPTZ
	`, { transaction });
};
