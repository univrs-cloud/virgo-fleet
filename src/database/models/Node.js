import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const Node = sequelize.define('Node', {
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
	name: {
		type: DataTypes.STRING,
		allowNull: false
	},
	lastSeenAt: {
		type: DataTypes.DATE,
		allowNull: true
	},
	token: {
		type: DataTypes.STRING,
		allowNull: true,
		unique: true
	},
	ownerUserId: {
		type: DataTypes.INTEGER,
		allowNull: true
	}
}, {
	tableName: 'nodes'
});

export default Node;
