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
	},
	// Signature of the update set last pushed to members, so a node re-reporting the same available
	// updates (it re-sends node:updates on every reconnect) doesn't re-notify. Empty when there are
	// no updates. See NodeModule's push handler.
	lastUpdateSignature: {
		type: DataTypes.TEXT,
		allowNull: true
	}
}, {
	tableName: 'nodes'
});

export default Node;
