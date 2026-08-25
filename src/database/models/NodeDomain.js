import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const NodeDomain = sequelize.define('NodeDomain', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	nodeId: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
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
	lanIp: {
		type: DataTypes.STRING,
		allowNull: true
	},
	publicIp: {
		type: DataTypes.STRING,
		allowNull: true
	},
	target: {
		type: DataTypes.ENUM('public', 'lan'),
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
	tableName: 'node_domains'
});

export default NodeDomain;
