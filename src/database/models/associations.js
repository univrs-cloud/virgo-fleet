import Node from './Node.js';
import FleetSession from './FleetSession.js';
import FleetPendingUser from './FleetPendingUser.js';
import FleetUser from './FleetUser.js';
import FleetGroup from './FleetGroup.js';
import FleetRecoveryCode from './FleetRecoveryCode.js';
import { sequelize } from '../index.js';
import { DataTypes } from 'sequelize';

const FleetUserGroup = sequelize.define('FleetUserGroup', {
	role: {
		type: DataTypes.ENUM('member', 'manager'),
		allowNull: false,
		defaultValue: 'member'
	}
}, {
	tableName: 'fleet_user_groups'
});

const NodeAccess = sequelize.define('NodeAccess', {
	role: {
		type: DataTypes.ENUM('owner', 'admin'),
		allowNull: false,
		defaultValue: 'admin'
	}
}, {
	tableName: 'node_accesses'
});

const GroupNodeAccess = sequelize.define('GroupNodeAccess', {}, {
	tableName: 'group_node_accesses'
});

FleetUser.belongsToMany(FleetGroup, { through: FleetUserGroup, foreignKey: 'fleetUserId', otherKey: 'fleetGroupId' });
FleetGroup.belongsToMany(FleetUser, { through: FleetUserGroup, foreignKey: 'fleetGroupId', otherKey: 'fleetUserId' });

FleetUser.hasMany(FleetSession, { foreignKey: 'fleetUserId', onDelete: 'CASCADE' });
FleetSession.belongsTo(FleetUser, { foreignKey: 'fleetUserId', onDelete: 'CASCADE' });

FleetUser.hasMany(FleetRecoveryCode, { foreignKey: 'fleetUserId', onDelete: 'CASCADE' });
FleetRecoveryCode.belongsTo(FleetUser, { foreignKey: 'fleetUserId', onDelete: 'CASCADE' });

FleetUser.belongsToMany(Node, { through: NodeAccess, foreignKey: 'fleetUserId', otherKey: 'nodeId' });
Node.belongsToMany(FleetUser, { through: NodeAccess, foreignKey: 'nodeId', otherKey: 'fleetUserId' });

FleetGroup.belongsToMany(Node, { through: GroupNodeAccess, foreignKey: 'fleetGroupId', otherKey: 'nodeId' });
Node.belongsToMany(FleetGroup, { through: GroupNodeAccess, foreignKey: 'nodeId', otherKey: 'fleetGroupId' });

// Deleting a user cascades to the nodes they own and the groups they created, and those in turn
// cascade to their access/membership/share join rows — so removing a user cleans up everything
// they owned without any application-level enumeration.
Node.belongsTo(FleetUser, { as: 'owner', foreignKey: 'ownerUserId', onDelete: 'CASCADE' });
FleetUser.hasMany(Node, { as: 'ownedNodes', foreignKey: 'ownerUserId', onDelete: 'CASCADE' });

FleetGroup.belongsTo(FleetUser, { as: 'creator', foreignKey: 'createdByUserId', onDelete: 'CASCADE' });
FleetUser.hasMany(FleetGroup, { as: 'createdGroups', foreignKey: 'createdByUserId', onDelete: 'CASCADE' });

export {
	FleetUser,
	FleetGroup,
	Node,
	FleetSession,
	FleetPendingUser,
	FleetRecoveryCode,
	FleetUserGroup,
	NodeAccess,
	GroupNodeAccess
};
