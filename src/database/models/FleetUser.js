import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const FleetUser = sequelize.define('FleetUser', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	email: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	displayName: {
		type: DataTypes.STRING,
		allowNull: true
	},
	passwordHash: {
		type: DataTypes.STRING,
		allowNull: false
	},
	isDisabled: {
		type: DataTypes.BOOLEAN,
		allowNull: false,
		defaultValue: false
	}
}, {
	tableName: 'fleet_users'
});

export default FleetUser;
