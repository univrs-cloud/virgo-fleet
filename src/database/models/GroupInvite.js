import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const GroupInvite = sequelize.define('GroupInvite', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	email: {
		type: DataTypes.STRING,
		allowNull: true
	},
	token: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	status: {
		type: DataTypes.ENUM('pending', 'accepted', 'revoked'),
		allowNull: false,
		defaultValue: 'pending'
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	},
	invitedByUserId: {
		type: DataTypes.INTEGER,
		allowNull: true
	}
}, {
	tableName: 'group_invites'
});

export default GroupInvite;
