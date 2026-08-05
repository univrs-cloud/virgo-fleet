import { DataTypes } from 'sequelize';
import { sequelize } from '../index.js';

const Group = sequelize.define('Group', {
	id: {
		type: DataTypes.INTEGER,
		primaryKey: true,
		autoIncrement: true
	},
	name: {
		type: DataTypes.STRING,
		allowNull: false
	},
	description: {
		type: DataTypes.STRING,
		allowNull: true
	},
	createdByUserId: {
		type: DataTypes.INTEGER,
		allowNull: true
	}
}, {
	tableName: 'groups',
	// Group names are unique per creator, not globally: different users may share a name, but a
	// single user cannot have two groups with the same name. (NULLs compare as distinct in a
	// unique index, so legacy groups without a creator are exempt.)
	indexes: [
		{
			name: 'ux_groups_creator_name',
			unique: true,
			fields: ['createdByUserId', 'name']
		}
	]
});

export default Group;
