import Node from './Node.js';
import NodeConnectivityEvent from './NodeConnectivityEvent.js';
import Session from './Session.js';
import PendingUser from './PendingUser.js';
import User from './User.js';
import Group from './Group.js';
import RecoveryCode from './RecoveryCode.js';
import PushSubscription from './PushSubscription.js';
import { sequelize } from '../index.js';
import { DataTypes } from 'sequelize';

const UserGroup = sequelize.define('UserGroup', {
	role: {
		type: DataTypes.ENUM('member', 'manager'),
		allowNull: false,
		defaultValue: 'member'
	}
}, {
	tableName: 'user_groups'
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

User.belongsToMany(Group, { through: UserGroup, foreignKey: 'userId', otherKey: 'groupId' });
Group.belongsToMany(User, { through: UserGroup, foreignKey: 'groupId', otherKey: 'userId' });

User.hasMany(Session, { foreignKey: 'userId', onDelete: 'CASCADE' });
Session.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

User.hasMany(RecoveryCode, { foreignKey: 'userId', onDelete: 'CASCADE' });
RecoveryCode.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

User.hasMany(PushSubscription, { foreignKey: 'userId', onDelete: 'CASCADE' });
PushSubscription.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

User.belongsToMany(Node, { through: NodeAccess, foreignKey: 'userId', otherKey: 'nodeId' });
Node.belongsToMany(User, { through: NodeAccess, foreignKey: 'nodeId', otherKey: 'userId' });

Group.belongsToMany(Node, { through: GroupNodeAccess, foreignKey: 'groupId', otherKey: 'nodeId' });
Node.belongsToMany(Group, { through: GroupNodeAccess, foreignKey: 'nodeId', otherKey: 'groupId' });

// Deleting a user cascades to the nodes they own and the groups they created, and those in turn
// cascade to their access/membership/share join rows — so removing a user cleans up everything
// they owned without any application-level enumeration.
Node.belongsTo(User, { as: 'owner', foreignKey: 'ownerUserId', onDelete: 'CASCADE' });
User.hasMany(Node, { as: 'ownedNodes', foreignKey: 'ownerUserId', onDelete: 'CASCADE' });

Group.belongsTo(User, { as: 'creator', foreignKey: 'createdByUserId', onDelete: 'CASCADE' });
User.hasMany(Group, { as: 'createdGroups', foreignKey: 'createdByUserId', onDelete: 'CASCADE' });

// Connectivity events are keyed by the node's public nodeId (not its PK) so they can be recorded
// from the socket layer, and cascade away when the node is deleted.
Node.hasMany(NodeConnectivityEvent, { foreignKey: 'nodeId', sourceKey: 'nodeId', onDelete: 'CASCADE' });
NodeConnectivityEvent.belongsTo(Node, { foreignKey: 'nodeId', targetKey: 'nodeId', onDelete: 'CASCADE' });

export {
	User,
	Group,
	Node,
	NodeConnectivityEvent,
	Session,
	PendingUser,
	RecoveryCode,
	PushSubscription,
	UserGroup,
	NodeAccess,
	GroupNodeAccess
};
