import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

// A Web Push subscription for one of a user's installed PWAs. endpoint is the browser's push URL
// (unique per install, so re-subscribing upserts rather than duplicating); p256dh + auth are the
// client keys web-push needs to encrypt a payload. Rows are pruned when the push service reports the
// subscription gone (404/410), and cascade away with the owning user.
const FleetPushSubscription = sequelize.define('FleetPushSubscription', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	endpoint: {
		type: DataTypes.TEXT,
		allowNull: false,
		unique: true
	},
	p256dh: {
		type: DataTypes.STRING,
		allowNull: false
	},
	auth: {
		type: DataTypes.STRING,
		allowNull: false
	}
}, {
	tableName: 'fleet_push_subscriptions'
});

export default FleetPushSubscription;
