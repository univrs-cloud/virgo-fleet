import { Sequelize } from 'sequelize';

// Defaults to the mounted /data volume; DB_PATH lets tests (and alternate deployments) point
// the SQLite file elsewhere without touching the code.
const dbPath = process.env.DB_PATH || '/data/virgo.db';
const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: dbPath,
	logging: false
});

export { sequelize };
