import { Sequelize } from 'sequelize';

// Connection is driven by environment; defaults match the compose Postgres service. Postgres runs
// on the internal-only network with no external access and no TLS, so no SSL options are needed.
const sequelize = new Sequelize(
	process.env.DB_NAME || 'fleet',
	process.env.DB_USER || 'fleet',
	process.env.DB_PASSWORD || '',
	{
		host: process.env.DB_HOST || '127.0.0.1',
		port: Number(process.env.DB_PORT) || 5432,
		dialect: 'postgres',
		logging: false,
		// A small pool is plenty for the fleet's metadata workload and keeps Postgres'
		// per-connection (process) overhead low — important on a single-box deploy.
		pool: {
			max: Number(process.env.DB_POOL_MAX) || 10,
			min: 0,
			idle: 10000,
			acquire: 30000
		}
	}
);

export { sequelize };
