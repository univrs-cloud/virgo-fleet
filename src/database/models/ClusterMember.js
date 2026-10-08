import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const ClusterMember = sequelize.define('ClusterMember', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	clusterId: {
		type: DataTypes.INTEGER,
		allowNull: false
	},
	nodeId: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	lanIp: {
		type: DataTypes.STRING,
		allowNull: true
	},
	recordIds: {
		type: DataTypes.JSONB,
		allowNull: false,
		defaultValue: {}
	}
}, {
	tableName: 'cluster_members'
});

export default ClusterMember;
