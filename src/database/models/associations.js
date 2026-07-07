import FleetUser from './FleetUser.js';
import FleetGroup from './FleetGroup.js';
import Node from './Node.js';
import FleetSession from './FleetSession.js';
import GroupInvite from './GroupInvite.js';
import { sequelize } from '../index.js';
import { DataTypes } from 'sequelize';

const FleetUserGroup = sequelize.define('FleetUserGroup', {
	role: {
		type: DataTypes.ENUM('member', 'admin'),
		allowNull: false,
		defaultValue: 'member'
	}
}, {
	tableName: 'fleet_user_groups'
});

const NodeAccess = sequelize.define('NodeAccess', {
	role: {
		type: DataTypes.ENUM('owner', 'invited'),
		allowNull: false,
		defaultValue: 'invited'
	}
}, {
	tableName: 'node_accesses'
});

const GroupNodeAccess = sequelize.define('GroupNodeAccess', {}, {
	tableName: 'group_node_accesses'
});

FleetUser.belongsToMany(FleetGroup, { through: FleetUserGroup, foreignKey: 'fleetUserId', otherKey: 'fleetGroupId' });
FleetGroup.belongsToMany(FleetUser, { through: FleetUserGroup, foreignKey: 'fleetGroupId', otherKey: 'fleetUserId' });

FleetUser.hasMany(FleetSession, { foreignKey: 'fleetUserId' });
FleetSession.belongsTo(FleetUser, { foreignKey: 'fleetUserId' });

FleetUser.belongsToMany(Node, { through: NodeAccess, foreignKey: 'fleetUserId', otherKey: 'nodeId' });
Node.belongsToMany(FleetUser, { through: NodeAccess, foreignKey: 'nodeId', otherKey: 'fleetUserId' });

FleetGroup.belongsToMany(Node, { through: GroupNodeAccess, foreignKey: 'fleetGroupId', otherKey: 'nodeId' });
Node.belongsToMany(FleetGroup, { through: GroupNodeAccess, foreignKey: 'nodeId', otherKey: 'fleetGroupId' });

FleetGroup.hasMany(GroupInvite, { foreignKey: 'fleetGroupId' });
GroupInvite.belongsTo(FleetGroup, { foreignKey: 'fleetGroupId' });
FleetUser.hasMany(GroupInvite, { as: 'sentInvites', foreignKey: 'invitedByUserId' });
GroupInvite.belongsTo(FleetUser, { as: 'invitedBy', foreignKey: 'invitedByUserId' });

Node.belongsTo(FleetUser, { as: 'owner', foreignKey: 'ownerUserId' });
FleetUser.hasMany(Node, { as: 'ownedNodes', foreignKey: 'ownerUserId' });

export {
	FleetUser,
	FleetGroup,
	Node,
	FleetSession,
	GroupInvite,
	FleetUserGroup,
	NodeAccess,
	GroupNodeAccess
};
