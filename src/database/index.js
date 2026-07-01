import fs from 'fs';
import { Sequelize } from 'sequelize';

const dbPath = '/var/www/virgo-api/virgo.db';
const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: dbPath,
	logging: false
});

export { sequelize };
