import { Sequelize } from 'sequelize';

const dbPath = '/data/virgo.db';
const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: dbPath,
	logging: false
});

export { sequelize };
