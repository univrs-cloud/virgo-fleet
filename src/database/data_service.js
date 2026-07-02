import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { sequelize } from './index.js';
import {
	FleetUser,
	FleetGroup,
	Node,
	FleetSession,
	GroupInvite,
	FleetUserGroup,
	NodeAccess,
	GroupNodeAccess
} from './models/associations.js';
import { normalizeEmail } from '../utils/email.js';

const PASSWORD_COST = 12;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_ADMIN_EMAIL = 'admin@local';

function toPublicUser(user) {
	if (!user) {
		return null;
	}
	const plain = user.get ? user.get({ plain: true }) : user;
	return {
		id: plain.id,
		email: plain.email,
		displayName: plain.displayName,
		isAdmin: plain.isAdmin,
		isDisabled: plain.isDisabled,
		groups: plain.FleetGroups?.map((group) => {
			return {
				id: group.id,
				name: group.name,
				role: group.FleetUserGroup?.role || 'member'
			};
		}) || []
	};
}

class DataService {
	static async initialize() {
		await sequelize.sync();
		const userCount = await FleetUser.count();
		if (userCount === 0) {
			const passwordHash = bcrypt.hashSync('admin', PASSWORD_COST);
			await FleetUser.create({
				displayName: 'Administrator',
				email: DEFAULT_ADMIN_EMAIL,
				passwordHash,
				isAdmin: true
			});
		}
		return true;
	}

	static async getUsers() {
		const users = await FleetUser.findAll({
			include: [{
				model: FleetGroup,
				through: { attributes: ['role'] }
			}],
			order: [['email', 'ASC']]
		});
		return users.map(toPublicUser);
	}

	static async getUserByEmail(email) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail) {
			return null;
		}
		return FleetUser.findOne({
			where: { email: normalizedEmail },
			include: [{
				model: FleetGroup,
				through: { attributes: ['role'] }
			}]
		});
	}

	static async verifyCredentials({ email, password }) {
		const user = await this.getUserByEmail(email);
		if (!user || user.isDisabled) {
			return null;
		}
		if (!bcrypt.compareSync(password, user.passwordHash)) {
			return null;
		}
		return user;
	}

	static async getUserById(id) {
		return FleetUser.findByPk(id, {
			include: [{
				model: FleetGroup,
				through: { attributes: ['role'] }
			}]
		});
	}

	static async createUser({ email, displayName, password, isAdmin = false }) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail || !password) {
			throw new Error('email and password are required');
		}
		const existing = await this.getUserByEmail(normalizedEmail);
		if (existing) {
			throw new Error('User already exists.');
		}
		const user = await FleetUser.create({
			email: normalizedEmail,
			displayName: displayName || normalizedEmail,
			passwordHash: bcrypt.hashSync(password, PASSWORD_COST),
			isAdmin: Boolean(isAdmin)
		});
		return toPublicUser(user);
	}

	static async updateUser({ email, displayName, isAdmin }) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		if (displayName !== undefined) {
			user.displayName = displayName;
		}
		if (isAdmin !== undefined) {
			user.isAdmin = Boolean(isAdmin);
		}
		await user.save();
		return toPublicUser(user);
	}

	static async deleteUser(email) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		if (user.email === DEFAULT_ADMIN_EMAIL) {
			throw new Error('Owner cannot be deleted.');
		}
		await FleetSession.destroy({ where: { FleetUserId: user.id } });
		await user.destroy();
		return true;
	}

	static async changePassword(email, password) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		user.passwordHash = bcrypt.hashSync(password, PASSWORD_COST);
		await user.save();
		return true;
	}

	static async createSession(userId) {
		const token = randomBytes(48).toString('hex');
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		await FleetSession.create({
			token,
			expiresAt,
			FleetUserId: userId
		});
		return { token, expiresAt };
	}

	static async getSessionByToken(token) {
		if (!token) {
			return null;
		}
		return FleetSession.findOne({
			where: {
				token,
				expiresAt: { [Op.gt]: new Date() }
			},
			include: [FleetUser]
		});
	}

	static async deleteSession(token) {
		await FleetSession.destroy({ where: { token } });
	}

	static async login({ email, password }) {
		const user = await this.getUserByEmail(email);
		if (!user || user.isDisabled) {
			throw new Error('Invalid credentials.');
		}
		if (!bcrypt.compareSync(password, user.passwordHash)) {
			throw new Error('Invalid credentials.');
		}
		const session = await this.createSession(user.id);
		return {
			...session,
			user: toPublicUser(user)
		};
	}

	static async signup({ email, displayName, password }) {
		const userCount = await FleetUser.count();
		const user = await this.createUser({
			email,
			displayName,
			password,
			isAdmin: userCount === 0
		});
		const dbUser = await this.getUserByEmail(user.email);
		const session = await this.createSession(dbUser.id);
		return {
			...session,
			user
		};
	}

	static async getGroups() {
		const groups = await FleetGroup.findAll({
			include: [{
				model: FleetUser,
				through: { attributes: ['role'] },
				attributes: ['id', 'displayName', 'email']
			}, {
				model: Node,
				attributes: ['id', 'nodeId', 'name', 'lastSeenAt']
			}],
			order: [['name', 'ASC']]
		});
		return groups.map((group) => {
			const plain = group.get({ plain: true });
			return {
				id: plain.id,
				name: plain.name,
				description: plain.description,
				users: plain.FleetUsers?.map((user) => {
					return {
						id: user.id,
						email: user.email,
						displayName: user.displayName,
						role: user.FleetUserGroup?.role || 'member'
					};
				}) || [],
				nodes: plain.Nodes?.map((node) => {
					return {
						id: node.id,
						nodeId: node.nodeId,
						name: node.name,
						lastSeenAt: node.lastSeenAt
					};
				}) || []
			};
		});
	}

	static async createGroup({ name, description }) {
		const normalizedName = String(name || '').trim();
		if (!normalizedName) {
			throw new Error('Group name is required.');
		}
		const existing = await FleetGroup.findOne({ where: { name: normalizedName } });
		if (existing) {
			throw new Error('Group already exists.');
		}
		return FleetGroup.create({
			name: normalizedName,
			description: description || null
		});
	}

	static async updateGroup({ name, description, newName }) {
		const group = await FleetGroup.findOne({ where: { name } });
		if (!group) {
			throw new Error(`Group ${name} not found.`);
		}
		if (newName) {
			group.name = newName;
		}
		if (description !== undefined) {
			group.description = description;
		}
		await group.save();
		return group;
	}

	static async deleteGroup(name) {
		const group = await FleetGroup.findOne({ where: { name } });
		if (!group) {
			throw new Error(`Group ${name} not found.`);
		}
		await GroupInvite.destroy({ where: { FleetGroupId: group.id } });
		await group.destroy();
		return true;
	}

	static async addUserToGroup({ groupName, email, role = 'member' }) {
		const group = await FleetGroup.findOne({ where: { name: groupName } });
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.addFleetUser(user, { through: { role } });
		return true;
	}

	static async removeUserFromGroup({ groupName, email }) {
		const group = await FleetGroup.findOne({ where: { name: groupName } });
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.removeFleetUser(user);
		return true;
	}

	static async createGroupInvite({ groupName, invitedByUserId, email }) {
		const group = await FleetGroup.findOne({ where: { name: groupName } });
		if (!group) {
			throw new Error(`Group ${groupName} not found.`);
		}
		const normalizedEmail = normalizeEmail(email);
		const invite = await GroupInvite.create({
			FleetGroupId: group.id,
			InvitedByUserId: invitedByUserId,
			email: normalizedEmail || null,
			token: randomUUID(),
			status: 'pending',
			expiresAt: new Date(Date.now() + (1000 * 60 * 60 * 24 * 7))
		});
		return invite;
	}

	static async acceptGroupInvite(token, email) {
		const invite = await GroupInvite.findOne({
			where: {
				token,
				status: 'pending',
				expiresAt: { [Op.gt]: new Date() }
			},
			include: [FleetGroup]
		});
		if (!invite) {
			throw new Error('Invite not found or expired.');
		}
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error('User not found.');
		}
		await invite.FleetGroup.addFleetUser(user, { through: { role: 'member' } });
		invite.status = 'accepted';
		await invite.save();
		return true;
	}

	static async upsertNode({ nodeId, name, ownerUserId }) {
		const normalizedNodeId = String(nodeId || '').trim();
		if (!normalizedNodeId) {
			throw new Error('nodeId is required');
		}
		const [node] = await Node.findOrCreate({
			where: { nodeId: normalizedNodeId },
			defaults: {
				nodeId: normalizedNodeId,
				name: name || normalizedNodeId,
				lastSeenAt: new Date(),
				OwnerUserId: ownerUserId || null,
				token: randomBytes(32).toString('hex')
			}
		});
		node.name = name || node.name;
		node.lastSeenAt = new Date();
		if (ownerUserId) {
			node.OwnerUserId = ownerUserId;
		}
		if (!node.token) {
			node.token = randomBytes(32).toString('hex');
		}
		await node.save();
		return node;
	}

	static async getNodeByToken(token) {
		const normalizedToken = String(token || '').trim();
		if (!normalizedToken) {
			return null;
		}
		return Node.findOne({ where: { token: normalizedToken } });
	}

	static async grantNodeAccess({ email, nodeId, role = 'invited' }) {
		const user = await this.getUserByEmail(email);
		const node = await Node.findOne({ where: { nodeId } });
		if (!user || !node) {
			throw new Error('User or node not found.');
		}
		await node.addFleetUser(user, { through: { role } });
		return true;
	}

	static async grantGroupNodeAccess({ groupName, nodeId }) {
		const group = await FleetGroup.findOne({ where: { name: groupName } });
		const node = await Node.findOne({ where: { nodeId } });
		if (!group || !node) {
			throw new Error('Group or node not found.');
		}
		await group.addNode(node);
		return true;
	}

	static async listAccessibleNodes(userId) {
		const user = await FleetUser.findByPk(userId, {
			include: [{
				model: FleetGroup,
				include: [Node]
			}, Node]
		});
		if (!user) {
			return [];
		}
		const nodes = new Map();
		for (const node of user.Nodes || []) {
			nodes.set(node.nodeId, {
				nodeId: node.nodeId,
				name: node.name,
				lastSeenAt: node.lastSeenAt,
				access: 'direct'
			});
		}
		for (const group of user.FleetGroups || []) {
			for (const node of group.Nodes || []) {
				nodes.set(node.nodeId, {
					nodeId: node.nodeId,
					name: node.name,
					lastSeenAt: node.lastSeenAt,
					access: `group:${group.name}`
				});
			}
		}
		return [...nodes.values()];
	}

	static async canUserAccessNode(userId, nodeId) {
		const nodes = await this.listAccessibleNodes(userId);
		return nodes.some((node) => { return node.nodeId === nodeId; });
	}

	static async isNodeOwner(userId, nodeId) {
		const node = await Node.findOne({ where: { nodeId } });
		return Boolean(node && node.OwnerUserId === userId);
	}
}

export default DataService;
