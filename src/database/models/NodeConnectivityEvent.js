import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// One row per connectivity transition (connect / disconnect). The bar in the fleet grid is
// reconstructed from these; createdAt is the moment the transition happened.
const NodeConnectivityEvent = sequelize.define('NodeConnectivityEvent', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	nodeId: {
		type: DataTypes.STRING,
		allowNull: false
	},
	online: {
		type: DataTypes.BOOLEAN,
		allowNull: false
	}
}, {
	tableName: 'node_connectivity_events',
	indexes: [
		{ fields: ['nodeId', 'createdAt'] }
	]
});

export default NodeConnectivityEvent;
