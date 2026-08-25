import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const AcmeChallenge = sequelize.define('AcmeChallenge', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	nodeId: {
		type: DataTypes.STRING,
		allowNull: false
	},
	name: {
		type: DataTypes.STRING,
		allowNull: false
	},
	value: {
		type: DataTypes.STRING,
		allowNull: false
	},
	recordId: {
		type: DataTypes.STRING,
		allowNull: false
	}
}, {
	tableName: 'acme_challenges',
	indexes: [
		{ fields: ['nodeId'] },
		{ fields: ['name', 'value'] }
	]
});

export default AcmeChallenge;
