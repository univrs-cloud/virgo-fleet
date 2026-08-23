import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// A challenge in flight between the options call and the verify call. It lives in the database
// rather than in memory so the two halves of a ceremony can land on different fleet instances,
// and the row is deleted the moment it's consumed — a challenge is single-use by definition, and
// replaying one must not work.
const WebauthnChallenge = sequelize.define('WebauthnChallenge', {
	// Handed to the client and echoed back on verify. Random rather than sequential so one caller
	// can't consume another's pending challenge.
	id: {
		type: DataTypes.STRING,
		primaryKey: true
	},
	challenge: {
		type: DataTypes.STRING,
		allowNull: false
	},
	// 'registration' or 'authentication'. Checked on consume so a registration challenge can't be
	// redeemed through the (unauthenticated) sign-in endpoint.
	type: {
		type: DataTypes.STRING,
		allowNull: false
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	}
}, {
	tableName: 'webauthn_challenges'
});

export default WebauthnChallenge;
