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
	ownerUserId: {
		type: DataTypes.INTEGER,
		allowNull: true
	},
	machineId: {
		type: DataTypes.TEXT,
		allowNull: true
	},
	peers: {
		type: DataTypes.JSONB,
		allowNull: true
	},
	name: {
		type: DataTypes.STRING,
		allowNull: false
	},
	token: {
		type: DataTypes.STRING,
		allowNull: true,
		unique: true
	},
	lastSeenAt: {
		type: DataTypes.DATE,
		allowNull: true
	},
	// Signature of the update set last pushed to members, so a node re-reporting the same available
	// updates (it re-sends node:updates on every reconnect) doesn't re-notify. Empty when there are
	// no updates. See NodeModule's push handler.
	lastUpdateSignature: {
		type: DataTypes.TEXT,
		allowNull: true
	},
	// Signature of the per-pool health states last pushed to members, so the node re-reporting the same
	// storage (it re-sends node:storage on every poll) only notifies when a pool's state actually changes.
	lastStorageSignature: {
		type: DataTypes.TEXT,
		allowNull: true
	}
}, {
	tableName: 'nodes'
});

export default Node;
