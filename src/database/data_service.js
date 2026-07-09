import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { sequelize } from './index.js';
import {
	Node,
	NodeAccess,
	FleetSession,
	FleetPendingUser,
	FleetUser,
	FleetGroup,
	FleetUserGroup,
	GroupNodeAccess
} from './models/associations.js';
import { normalizeEmail } from '../utils/email.js';

const PASSWORD_COST = 12;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
// A verification link is only good for 30 minutes; after that the pending row is dead weight
// and re-registering the same email issues a fresh one.
const PENDING_TTL_MS = 1000 * 60 * 30;

function toPublicUser(user) {
	if (!user) {
		return null;
	}
	const plain = user.get ? user.get({ plain: true }) : user;
	return {
		id: plain.id,
		email: plain.email,
		displayName: plain.displayName,
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

	static async createUser({ email, displayName, password }) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail || !password) {
			throw new Error('email and password are required.');
		}
		const existing = await this.getUserByEmail(normalizedEmail);
		if (existing) {
			throw new Error('User already exists.');
		}
		const user = await FleetUser.create({
			email: normalizedEmail,
			displayName: displayName || normalizedEmail,
			passwordHash: bcrypt.hashSync(password, PASSWORD_COST)
		});
		return toPublicUser(user);
	}

	static async updateUser({ email, displayName }) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		if (displayName !== undefined) {
			user.displayName = displayName;
		}
		await user.save();
		return toPublicUser(user);
	}

	static async deleteUser(email) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		// Sessions, owned nodes, created groups, memberships and access rows all cascade from this.
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
		// Invalidate every existing session so a changed password logs out all devices.
		await FleetSession.destroy({ where: { fleetUserId: user.id } });
		return true;
	}

	static async createSession(userId) {
		const token = randomBytes(48).toString('hex');
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		// Opportunistically clear this user's expired sessions whenever they log in.
		await FleetSession.destroy({ where: { fleetUserId: userId, expiresAt: { [Op.lt]: new Date() } } });
		await FleetSession.create({
			token,
			expiresAt,
			fleetUserId: userId
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

	// Registers an account into the pending table and returns the verification token so the
	// caller can email it. No fleet_users row and no session are created here — the account
	// does not exist for login purposes until the link is clicked.
	static async createPendingUser({ email, displayName, password }) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail || !password) {
			throw new Error('email and password are required.');
		}
		// A verified account already owns this email — registration must not shadow it.
		const existing = await this.getUserByEmail(normalizedEmail);
		if (existing) {
			throw new Error('User already exists.');
		}
		// Housekeeping: drop pending rows whose links have already lapsed so the table doesn't
		// accumulate dead registrations.
		await FleetPendingUser.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
		const token = randomBytes(48).toString('hex');
		const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
		// Upsert keyed on the unique email: a repeat signup before verification (e.g. the first
		// email never arrived) overwrites the pending row in place, issuing a fresh token and
		// expiry and invalidating the previous link.
		await FleetPendingUser.upsert({
			email: normalizedEmail,
			displayName: displayName || normalizedEmail,
			passwordHash: bcrypt.hashSync(password, PASSWORD_COST),
			verificationToken: token,
			expiresAt
		});
		return { email: normalizedEmail, displayName: displayName || normalizedEmail, token, expiresAt };
	}

	static async deletePendingUser(email) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail) {
			return false;
		}
		await FleetPendingUser.destroy({ where: { email: normalizedEmail } });
		return true;
	}

	// Promotes a pending account into fleet_users and logs it in. The move and the pending-row
	// deletion run in one transaction so a verified account can never exist in both tables.
	static async verifyPendingUser(token) {
		if (!token) {
			throw new Error('This verification link is invalid or has expired.');
		}
		const pending = await FleetPendingUser.findOne({
			where: {
				verificationToken: token,
				expiresAt: { [Op.gt]: new Date() }
			}
		});
		if (!pending) {
			throw new Error('This verification link is invalid or has expired.');
		}
		// Guard the race where the same email got verified through another link in the meantime.
		const existing = await this.getUserByEmail(pending.email);
		if (existing) {
			await pending.destroy();
			throw new Error('User already exists.');
		}
		const user = await sequelize.transaction(async (transaction) => {
			const created = await FleetUser.create({
				email: pending.email,
				displayName: pending.displayName,
				// Reuse the hash captured at registration — the password is never re-collected.
				passwordHash: pending.passwordHash
			}, { transaction });
			await pending.destroy({ transaction });
			return created;
		});
		const session = await this.createSession(user.id);
		return {
			...session,
			user: toPublicUser(user)
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

	/** Groups the user manages (manager role), in the same shape as getGroups(). A group and its
	 * member roster are visible only to its managers; regular members never see the group or its
	 * co-members — they only gain access to the nodes shared with it. */
	static async getManagedGroups(userId) {
		if (!userId) {
			return [];
		}
		const memberships = await FleetUserGroup.findAll({
			where: { fleetUserId: userId, role: 'manager' },
			attributes: ['fleetGroupId']
		});
		const groupIds = new Set(memberships.map((membership) => { return membership.fleetGroupId; }));
		if (groupIds.size === 0) {
			return [];
		}
		const groups = await this.getGroups();
		return groups.filter((group) => { return groupIds.has(group.id); });
	}

	/** Ids of a group's members, for targeting broadcasts when a node is shared with the group. */
	static async listGroupMemberUserIds(groupId) {
		const group = await FleetGroup.findByPk(groupId, {
			include: [{ model: FleetUser, attributes: ['id'], through: { attributes: [] } }]
		});
		if (!group) {
			return [];
		}
		return (group.FleetUsers || []).map((user) => { return user.id; });
	}

	static async createGroup({ name, description, createdByUserId }) {
		const normalizedName = String(name || '').trim();
		if (!normalizedName) {
			throw new Error('Group name is required.');
		}
		// Names are unique per creator, not globally: different users may each have a group with the
		// same name, but a single user cannot create two groups sharing a name.
		if (createdByUserId) {
			const existing = await FleetGroup.findOne({ where: { name: normalizedName, createdByUserId } });
			if (existing) {
				throw new Error('You already have a group with that name.');
			}
		}
		const group = await FleetGroup.create({
			name: normalizedName,
			description: description || null,
			createdByUserId: createdByUserId || null
		});
		if (createdByUserId) {
			const creator = await FleetUser.findByPk(createdByUserId);
			if (creator) {
				await group.addFleetUser(creator, { through: { role: 'manager' } });
			}
		}
		return group;
	}

	/** Group management (update/delete/membership/node-sharing) is restricted to members with the
	 * 'manager' role on that specific group (keyed by id, since names are not unique), as there is
	 * no global admin. */
	static async isGroupManager(userId, groupId) {
		if (!userId || !groupId) {
			return false;
		}
		const membership = await FleetUserGroup.findOne({
			where: { fleetUserId: userId, fleetGroupId: groupId }
		});
		return membership?.role === 'manager';
	}

	static async updateGroup({ groupId, description, newName }) {
		const group = await FleetGroup.findByPk(groupId);
		if (!group) {
			throw new Error(`Group ${groupId} not found.`);
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

	static async deleteGroup(groupId) {
		const group = await FleetGroup.findByPk(groupId);
		if (!group) {
			throw new Error(`Group ${groupId} not found.`);
		}
		await group.destroy();
		return true;
	}

	static async addUserToGroup({ groupId, email, role = 'member' }) {
		const group = await FleetGroup.findByPk(groupId);
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.addFleetUser(user, { through: { role } });
		return true;
	}

	static async removeUserFromGroup({ groupId, email }) {
		const group = await FleetGroup.findByPk(groupId);
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.removeFleetUser(user);
		return true;
	}

	static async upsertNode({ nodeId, name, ownerUserId }) {
		const normalizedNodeId = String(nodeId || '').trim();
		if (!normalizedNodeId) {
			throw new Error('nodeId is required.');
		}
		const [node, created] = await Node.findOrCreate({
			where: { nodeId: normalizedNodeId },
			defaults: {
				nodeId: normalizedNodeId,
				name: name || normalizedNodeId,
				lastSeenAt: new Date(),
				ownerUserId: ownerUserId || null,
				token: randomBytes(32).toString('hex')
			}
		});
		// Prevent ownership hijacking: an already-registered node can only be re-registered by its
		// current owner. Otherwise anyone who knows the nodeId could re-register it and steal it.
		if (!created && ownerUserId && node.ownerUserId && node.ownerUserId !== ownerUserId) {
			throw new Error('This node is already registered to another account.');
		}
		node.name = name || node.name;
		node.lastSeenAt = new Date();
		if (ownerUserId) {
			node.ownerUserId = ownerUserId;
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

	static async touchNodeLastSeen(nodeId) {
		const normalizedNodeId = String(nodeId || '').trim();
		if (!normalizedNodeId) {
			return;
		}
		try {
			await Node.update({ lastSeenAt: new Date() }, { where: { nodeId: normalizedNodeId } });
		} catch (error) {
			console.error(`Error updating lastSeenAt for node '${normalizedNodeId}':`, error);
		}
	}

	static async grantNodeAccess({ email, nodeId, role = 'admin' }) {
		const user = await this.getUserByEmail(email);
		const node = await Node.findOne({ where: { nodeId } });
		if (!user || !node) {
			throw new Error('User or node not found.');
		}
		await node.addFleetUser(user, { through: { role } });
		return true;
	}

	static async revokeNodeAccess({ email, nodeId }) {
		const user = await this.getUserByEmail(email);
		const node = await Node.findOne({ where: { nodeId } });
		if (!user || !node) {
			throw new Error('User or node not found.');
		}
		if (node.ownerUserId === user.id) {
			throw new Error('Node owner cannot be removed.');
		}
		await node.removeFleetUser(user);
		return true;
	}

	static async grantGroupNodeAccess({ groupId, nodeId }) {
		const group = await FleetGroup.findByPk(groupId);
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
				access: 'direct',
				isOwner: node.ownerUserId === userId
			});
		}
		for (const group of user.FleetGroups || []) {
			for (const node of group.Nodes || []) {
				if (nodes.has(node.nodeId)) {
					continue;
				}
				nodes.set(node.nodeId, {
					nodeId: node.nodeId,
					name: node.name,
					lastSeenAt: node.lastSeenAt,
					// Coarse label only — the granting group's name is never exposed to its members.
					access: 'group',
					isOwner: node.ownerUserId === userId
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
		return Boolean(node && node.ownerUserId === userId);
	}

	static async listNodeMembers(nodeId) {
		const node = await Node.findOne({
			where: { nodeId },
			include: [
				{
					model: FleetUser,
					through: { attributes: ['role'] }
				},
				{
					model: FleetGroup,
					attributes: ['id', 'name']
				}
			]
		});
		if (!node) {
			throw new Error(`Node ${nodeId} not found.`);
		}
		const plain = node.get({ plain: true });
		return {
			nodeId: plain.nodeId,
			name: plain.name,
			users: (plain.FleetUsers || []).map((user) => {
				return {
					email: user.email,
					displayName: user.displayName,
					role: user.NodeAccess?.role || 'admin'
				};
			}),
			groups: (plain.FleetGroups || []).map((group) => {
				return { name: group.name };
			})
		};
	}

	/** Ids of every user with access to a node (owner + directly-invited members), for targeting
	 * inventory broadcasts. Capture this before a removal so the user losing access is still included. */
	static async listNodeMemberUserIds(nodeId) {
		const node = await Node.findOne({
			where: { nodeId },
			include: [{ model: FleetUser, attributes: ['id'], through: { attributes: [] } }]
		});
		if (!node) {
			return [];
		}
		const ids = new Set();
		if (node.ownerUserId) {
			ids.add(node.ownerUserId);
		}
		for (const user of node.FleetUsers || []) {
			ids.add(user.id);
		}
		return [...ids];
	}

	/** nodeIds of the nodes a user owns. Captured before deleting the owner so we can still notify
	 * those nodes to unregister after the DB has cascade-deleted their records. */
	static async listNodesOwnedBy(userId) {
		if (!userId) {
			return [];
		}
		const nodes = await Node.findAll({ where: { ownerUserId: userId }, attributes: ['nodeId'] });
		return nodes.map((node) => { return node.nodeId; });
	}

	static async deleteNode(nodeId) {
		const node = await Node.findOne({ where: { nodeId } });
		if (!node) {
			throw new Error(`Node ${nodeId} not found.`);
		}
		await node.setFleetUsers([]);
		await node.setFleetGroups([]);
		await node.destroy();
		return true;
	}
}

export default DataService;
