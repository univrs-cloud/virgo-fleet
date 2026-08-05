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
	}
}, {
	tableName: 'sessions'
});

export default Session;
