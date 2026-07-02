import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const FleetGroup = sequelize.define('FleetGroup', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	name: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	description: {
		type: DataTypes.STRING,
		allowNull: true
	}
}, {
	tableName: 'fleet_groups'
});

export default FleetGroup;
