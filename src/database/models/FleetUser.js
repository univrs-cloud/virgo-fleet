import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const FleetUser = sequelize.define('FleetUser', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	email: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	name: {
		type: DataTypes.STRING,
		allowNull: true
	},
	passwordHash: {
		type: DataTypes.STRING,
		allowNull: false
	},
	isDisabled: {
		type: DataTypes.BOOLEAN,
		allowNull: false,
		defaultValue: false
	},
	// TOTP two-factor. totpEnabledAt null = not enrolled. totpPendingSecret holds the secret during
	// setup (before the first code is confirmed); on confirmation it moves to totpSecret. Both are
	// stored via the totp util (encrypted at rest when MFA_SECRET_KEY is set).
	totpSecret: {
		type: DataTypes.STRING,
		allowNull: true
	},
	totpPendingSecret: {
		type: DataTypes.STRING,
		allowNull: true
	},
	totpEnabledAt: {
		type: DataTypes.DATE,
		allowNull: true
	},
	// Account-level intent to receive Web Push update notifications. Set true when any device
	// subscribes, false when the user turns notifications off (which also drops every device's
	// subscription). Lets a new device know to obtain its own permission without a manual opt-in.
	pushEnabled: {
		type: DataTypes.BOOLEAN,
		allowNull: false,
		defaultValue: false
	}
}, {
	tableName: 'fleet_users'
});

export default FleetUser;
