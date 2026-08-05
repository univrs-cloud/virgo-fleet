import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// One-time backup codes for a user who's lost their authenticator. Stored bcrypt-hashed (never
// plaintext); usedAt is stamped when a code is consumed so it can't be replayed. A fresh set
// replaces the old one whenever recovery codes are (re)generated.
const RecoveryCode = sequelize.define('RecoveryCode', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	codeHash: {
		type: DataTypes.STRING,
		allowNull: false
	},
	usedAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
}, {
	tableName: 'recovery_codes'
});

export default RecoveryCode;
