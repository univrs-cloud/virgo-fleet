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

FleetUser.belongsToMany(FleetGroup, { through: FleetUserGroup });
FleetGroup.belongsToMany(FleetUser, { through: FleetUserGroup });

FleetUser.hasMany(FleetSession);
FleetSession.belongsTo(FleetUser);

FleetUser.belongsToMany(Node, { through: NodeAccess });
Node.belongsToMany(FleetUser, { through: NodeAccess });

FleetGroup.belongsToMany(Node, { through: GroupNodeAccess });
Node.belongsToMany(FleetGroup, { through: GroupNodeAccess });

FleetGroup.hasMany(GroupInvite);
GroupInvite.belongsTo(FleetGroup);
FleetUser.hasMany(GroupInvite, { as: 'sentInvites', foreignKey: 'InvitedByUserId' });
GroupInvite.belongsTo(FleetUser, { as: 'invitedBy', foreignKey: 'InvitedByUserId' });

Node.belongsTo(FleetUser, { as: 'owner', foreignKey: 'OwnerUserId' });
FleetUser.hasMany(Node, { as: 'ownedNodes', foreignKey: 'OwnerUserId' });

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
