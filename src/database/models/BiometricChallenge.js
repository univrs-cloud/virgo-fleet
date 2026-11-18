import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const BiometricChallenge = sequelize.define('BiometricChallenge', {
	id: {
		type: DataTypes.STRING,
		primaryKey: true
	},
	challenge: {
		type: DataTypes.STRING,
		allowNull: false
	},
	type: {
		type: DataTypes.STRING,
		allowNull: false
	},
	expiresAt: {
		type: DataTypes.DATE,
		allowNull: false
	}
}, {
	tableName: 'biometric_challenges'
});

export default BiometricChallenge;
