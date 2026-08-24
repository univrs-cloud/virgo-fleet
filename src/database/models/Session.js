import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const Session = sequelize.define('Session', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	token: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	},
	// Two-factor gate for the session: 'setup_required' (enrolled? no — must set up TOTP first),
	// 'challenge_required' (password ok, awaiting a code this login), 'satisfied' (full access).
	// Only 'satisfied' sessions authenticate for anything beyond the MFA endpoints.
	mfaState: {
		type: DataTypes.STRING,
		allowNull: false,
		defaultValue: 'satisfied'
	},
	// Captured at sign-in and never updated — they describe where the session came from, not the
	// latest request. Null on sessions that predate the profile's session list.
	ipAddress: {
		type: DataTypes.STRING,
		allowNull: true
	},
	userAgent: {
		type: DataTypes.TEXT,
		allowNull: true
	},
	// Written at most once a minute (see DataService.touchSession) so it can't turn every request
	// into a write.
	lastSeenAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
}, {
	tableName: 'sessions'
});

export default Session;
