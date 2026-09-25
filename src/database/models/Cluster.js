import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const Cluster = sequelize.define('Cluster', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	label: {
		type: DataTypes.STRING,
		allowNull: false
	},
	fqdn: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	ownerUserId: {
		type: DataTypes.INTEGER,
		allowNull: true
	},
	lanIp: {
		type: DataTypes.STRING,
		allowNull: true
	},
	publicIp: {
		type: DataTypes.STRING,
		allowNull: true
	},
	target: {
		type: DataTypes.STRING,
		allowNull: false,
		defaultValue: 'lan'
	},
	recordIds: {
		type: DataTypes.JSONB,
		allowNull: false,
		defaultValue: {}
	},
	lastIssuedAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
}, {
	tableName: 'clusters'
});

export default Cluster;
