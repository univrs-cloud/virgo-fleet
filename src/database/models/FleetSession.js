import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const FleetSession = sequelize.define('FleetSession', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	token: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	}
}, {
	tableName: 'fleet_sessions'
});

export default FleetSession;
