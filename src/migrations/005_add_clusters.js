export default async ({ sequelize, transaction }) => {
	await sequelize.query(`
		DO $$
		BEGIN
			IF to_regclass('public.nodes') IS NULL THEN
				RETURN;
			END IF;

			CREATE TABLE IF NOT EXISTS "clusters" (
				"id" SERIAL PRIMARY KEY,
				"label" VARCHAR(255) NOT NULL,
				"fqdn" VARCHAR(255) NOT NULL UNIQUE,
				"ownerUserId" INTEGER,
				"lanIp" VARCHAR(255),
				"publicIp" VARCHAR(255),
				"target" VARCHAR(255) NOT NULL DEFAULT 'lan',
				"recordIds" JSONB NOT NULL DEFAULT '{}',
				"lastIssuedAt" TIMESTAMPTZ,
				"createdAt" TIMESTAMPTZ NOT NULL,
				"updatedAt" TIMESTAMPTZ NOT NULL
			);

			CREATE TABLE IF NOT EXISTS "cluster_members" (
				"id" SERIAL PRIMARY KEY,
				"clusterId" INTEGER NOT NULL REFERENCES "clusters" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
				"nodeId" VARCHAR(255) NOT NULL UNIQUE REFERENCES "nodes" ("nodeId") ON DELETE CASCADE ON UPDATE CASCADE,
				"createdAt" TIMESTAMPTZ NOT NULL,
				"updatedAt" TIMESTAMPTZ NOT NULL
			);

			IF to_regclass('public.node_domains') IS NOT NULL THEN
				INSERT INTO "clusters" ("label", "fqdn", "ownerUserId", "lanIp", "publicIp", "target", "recordIds", "lastIssuedAt", "createdAt", "updatedAt")
				SELECT "d"."label", "d"."fqdn", "n"."ownerUserId", "d"."lanIp", "d"."publicIp", "d"."target"::TEXT, "d"."recordIds", "d"."lastIssuedAt", "d"."createdAt", "d"."updatedAt"
				FROM "node_domains" "d"
				JOIN "nodes" "n" ON "n"."nodeId" = "d"."nodeId"
				ON CONFLICT ("fqdn") DO NOTHING;

				INSERT INTO "cluster_members" ("clusterId", "nodeId", "createdAt", "updatedAt")
				SELECT "c"."id", "d"."nodeId", "d"."createdAt", "d"."updatedAt"
				FROM "node_domains" "d"
				JOIN "clusters" "c" ON "c"."fqdn" = "d"."fqdn"
				ON CONFLICT ("nodeId") DO NOTHING;

				DROP TABLE "node_domains";
				DROP TYPE IF EXISTS "enum_node_domains_target";
			END IF;
		END
		$$;
	`, { transaction });
};
