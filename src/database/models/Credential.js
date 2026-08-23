import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// One enrolled WebAuthn authenticator (a passkey). Created only from an MFA-satisfied session, so
// a credential can never exist unless the user already cleared password + TOTP on some device;
// that's what lets a later assertion stand in for both.
const Credential = sequelize.define('Credential', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	// The authenticator's credential ID, base64url. Unique across the fleet — an assertion arrives
	// with nothing but this, so it's how the account is resolved.
	credentialId: {
		type: DataTypes.STRING,
		allowNull: false,
		unique: true
	},
	// COSE public key, base64url. Public by definition, so unlike a TOTP secret it needs no
	// encryption at rest.
	publicKey: {
		type: DataTypes.TEXT,
		allowNull: false
	},
	// Signature counter. BIGINT because the spec's uint32 range overflows a Postgres integer;
	// pg hands it back as a string, so read it through Number().
	counter: {
		type: DataTypes.BIGINT,
		allowNull: false,
		defaultValue: 0
	},
	transports: {
		type: DataTypes.ARRAY(DataTypes.STRING),
		allowNull: false,
		defaultValue: []
	},
	// 'singleDevice' (bound to this authenticator) or 'multiDevice' (syncable). Kept because it
	// decides whether losing one device loses the credential.
	deviceType: {
		type: DataTypes.STRING,
		allowNull: true
	},
	backedUp: {
		type: DataTypes.BOOLEAN,
		allowNull: false,
		defaultValue: false
	},
	lastUsedAt: {
		type: DataTypes.DATE,
		allowNull: true
	}
}, {
	tableName: 'credentials'
});

export default Credential;
