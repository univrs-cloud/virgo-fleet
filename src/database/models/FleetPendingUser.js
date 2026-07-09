import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// Holds accounts that have registered but not yet clicked the email verification link.
// A row lives here — never in fleet_users — until verified, so login (which only reads
// fleet_users) can never authenticate an unverified account. On verification the row is
// promoted into fleet_users and deleted from here.
const FleetPendingUser = sequelize.define('FleetPendingUser', {
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
	displayName: {
		type: DataTypes.STRING,
		allowNull: true
	},
	// The password is already bcrypt-hashed before it lands here — plaintext is never stored,
	// even transiently, while the account waits to be verified.
	passwordHash: {
		type: DataTypes.STRING,
		allowNull: false
	},
	verificationToken: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	}
}, {
	tableName: 'fleet_pending_users'
});

export default FleetPendingUser;
