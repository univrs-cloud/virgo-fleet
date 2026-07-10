import { Sequelize } from 'sequelize';

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '/data/virgo.db',
	logging: false
});

await sequelize.query('PRAGMA journal_mode = WAL;');
await sequelize.query('PRAGMA busy_timeout = 5000;');
await sequelize.query('PRAGMA synchronous = NORMAL;');

export { sequelize };
