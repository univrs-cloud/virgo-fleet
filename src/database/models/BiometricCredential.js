import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const BiometricCredential = sequelize.define('BiometricCredential', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	credentialId: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	publicKey: {
		type: DataTypes.TEXT,
		allowNull: false
	},
	lastUsedAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
}, {
	tableName: 'biometric_credentials'
});

export default BiometricCredential;
