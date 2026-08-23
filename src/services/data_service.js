import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { sequelize } from '../database/index.js';
import {
	Node,
	NodeConnectivityEvent,
	NodeAccess,
	Session,
	PendingUser,
	User,
	Group,
	RecoveryCode,
	Credential,
	WebauthnChallenge,
	UserGroup,
	GroupNodeAccess,
	PushSubscription
} from '../database/models/associations.js';
import { normalizeEmail } from '../utils/email.js';
import {
	encryptSecret,
	decryptSecret,
	generateSecret,
	buildOtpauthUrl,
	verifyToken,
	generateRecoveryCodes,
	hashRecoveryCode,
	verifyRecoveryCode
} from '../utils/totp.js';
import {
	buildAuthenticationOptions,
	buildRegistrationOptions,
	verifyAuthentication,
	verifyRegistration
} from '../utils/webauthn.js';

const PASSWORD_COST = 12;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
// A verification link is only good for 30 minutes; after that the pending row is dead weight
// and re-registering the same email issues a fresh one.
const PENDING_TTL_MS = 1000 * 60 * 30;
// The connectivity bar covers 24h; keep an hour of slack so the "state at the window start" seed
// is always available. Each node's most-recent event at-or-before this cutoff is retained beyond
// it regardless (see pruneConnectivityEvents), so a node stable for days still keeps the one
// transition that tells us its current state and since when.
const CONNECTIVITY_RETENTION_MS = 1000 * 60 * 60 * 25;
// A WebAuthn ceremony is two round-trips with a user gesture in between; the authenticator's own
// timeout is 60s, so two minutes is generous and still keeps a stolen challenge worthless.
const WEBAUTHN_CHALLENGE_TTL_MS = 1000 * 60 * 2;

function toPublicUser(user) {
	if (!user) {
		return null;
	}
	const plain = user.get ? user.get({ plain: true }) : user;
	return {
		id: plain.id,
		email: plain.email,
		name: plain.name,
		isDisabled: plain.isDisabled,
		groups: plain.Groups?.map((group) => {
			return {
				id: group.id,
				name: group.name,
				role: group.UserGroup?.role || 'member'
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
		const users = await User.findAll({
			include: [{
				model: Group,
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
		return User.findOne({
			where: { email: normalizedEmail },
			include: [{
				model: Group,
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
		return User.findByPk(id, {
			include: [{
				model: Group,
				through: { attributes: ['role'] }
			}]
		});
	}

	static async createUser({ email, name, password }) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail || !password) {
			throw new Error('email and password are required.');
		}
		const existing = await this.getUserByEmail(normalizedEmail);
		if (existing) {
			throw new Error('User already exists.');
		}
		const user = await User.create({
			email: normalizedEmail,
			name: name || normalizedEmail,
			passwordHash: bcrypt.hashSync(password, PASSWORD_COST)
		});
		return toPublicUser(user);
	}

	static async updateUser({ email, name }) {
		const user = await this.getUserByEmail(email);
		if (!user) {
			throw new Error(`User ${email} not found.`);
		}
		if (name !== undefined) {
			user.name = name;
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
		await Session.destroy({ where: { userId: user.id } });
		return true;
	}

	static async createSession(userId, mfaState = 'satisfied') {
		const token = randomBytes(48).toString('hex');
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		// Opportunistically clear this user's expired sessions whenever they log in.
		await Session.destroy({ where: { userId: userId, expiresAt: { [Op.lt]: new Date() } } });
		await Session.create({
			token,
			expiresAt,
			userId: userId,
			mfaState
		});
		return { token, expiresAt };
	}

	static async setSessionMfaState(token, mfaState) {
		await Session.update({ mfaState }, { where: { token } });
	}

	static async getSessionByToken(token) {
		if (!token) {
			return null;
		}
		return Session.findOne({
			where: {
				token,
				expiresAt: { [Op.gt]: new Date() }
			},
			include: [User]
		});
	}

	static async deleteSession(token) {
		await Session.destroy({ where: { token } });
	}

	static async login({ email, password }) {
		const user = await this.getUserByEmail(email);
		if (!user || user.isDisabled) {
			throw new Error('Invalid credentials.');
		}
		if (!bcrypt.compareSync(password, user.passwordHash)) {
			throw new Error('Invalid credentials.');
		}
		// Mandatory TOTP: an enrolled user must clear a code this login; an unenrolled user is forced
		// into setup. Either way the session starts gated — only the MFA endpoints can lift it.
		const mfaState = user.totpEnabledAt ? 'challenge_required' : 'setup_required';
		const session = await this.createSession(user.id, mfaState);
		return {
			...session,
			mfaState,
			user: toPublicUser(user)
		};
	}

	/** Begin (or restart) TOTP enrollment: generate a fresh secret, stash it as the pending secret,
	 * and return the plaintext secret + otpauth URI (for the QR). Not active until confirmed. */
	static async beginTotpSetup(userId) {
		const user = await User.findByPk(userId);
		if (!user) {
			throw new Error('User not found.');
		}
		const secret = generateSecret();
		user.totpPendingSecret = encryptSecret(secret);
		await user.save();
		return { secret, otpauthUrl: buildOtpauthUrl(user.email, secret) };
	}

	/** Confirm enrollment: the code must match the pending secret. On success the pending secret
	 * becomes the active one, TOTP is marked enabled, and a fresh set of recovery codes is issued
	 * (returned in plaintext once). Atomic, so TOTP is never enabled without recovery codes. */
	static async confirmTotpSetup(userId, code) {
		const user = await User.findByPk(userId);
		if (!user || !user.totpPendingSecret) {
			throw new Error('No TOTP setup in progress.');
		}
		if (!verifyToken(code, decryptSecret(user.totpPendingSecret))) {
			throw new Error('That code is not valid. Try again with a fresh code from your app.');
		}
		const recoveryCodes = generateRecoveryCodes();
		await sequelize.transaction(async (transaction) => {
			user.totpSecret = user.totpPendingSecret;
			user.totpPendingSecret = null;
			user.totpEnabledAt = new Date();
			await user.save({ transaction });
			await RecoveryCode.destroy({ where: { userId: userId }, transaction });
			await RecoveryCode.bulkCreate(
				recoveryCodes.map((plain) => { return { userId: userId, codeHash: hashRecoveryCode(plain) }; }),
				{ transaction }
			);
		});
		return { recoveryCodes };
	}

	/** Verify a TOTP code for the login challenge (against the active secret). */
	static async verifyTotpChallenge(userId, code) {
		const user = await User.findByPk(userId);
		if (!user || !user.totpSecret) {
			return false;
		}
		return verifyToken(code, decryptSecret(user.totpSecret));
	}

	/** Verify and consume a one-time recovery code (bcrypt-compared, then stamped used). */
	static async consumeRecoveryCode(userId, code) {
		const rows = await RecoveryCode.findAll({ where: { userId: userId, usedAt: null } });
		for (const row of rows) {
			if (verifyRecoveryCode(code, row.codeHash)) {
				row.usedAt = new Date();
				await row.save();
				return true;
			}
		}
		return false;
	}

	static async countRemainingRecoveryCodes(userId) {
		return RecoveryCode.count({ where: { userId: userId, usedAt: null } });
	}

	/** Stash a challenge for the second half of a ceremony and return the handle the client echoes
	 * back. Expired rows are swept here so the table never needs its own janitor. */
	static async createWebauthnChallenge({ challenge, type, userId = null }) {
		await WebauthnChallenge.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
		const id = randomBytes(32).toString('hex');
		await WebauthnChallenge.create({
			id,
			challenge,
			type,
			userId,
			expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS)
		});
		return id;
	}

	/** Redeem a challenge. Deleted whether or not it matched, so a handle is good for exactly one
	 * attempt and a wrong `type` can't be retried against the right endpoint. */
	static async consumeWebauthnChallenge(id, type) {
		// The handle comes straight off the request body, so refuse anything that isn't the string
		// we issued rather than letting Sequelize coerce it.
		if (typeof id !== 'string' || !id) {
			return null;
		}
		const row = await WebauthnChallenge.findByPk(id);
		if (!row) {
			return null;
		}
		await row.destroy();
		if (row.type !== type || row.expiresAt.getTime() < Date.now()) {
			return null;
		}
		return { challenge: row.challenge, userId: row.userId };
	}

	static async getCredentialsForUser(userId) {
		return Credential.findAll({ where: { userId: userId }, order: [['createdAt', 'ASC']] });
	}

	/** Begin enrollment. Callers must already hold a satisfied session — that gate is what keeps a
	 * passkey from ever becoming a first factor in its own right. */
	static async beginPasskeyRegistration(userId) {
		const user = await User.findByPk(userId);
		if (!user) {
			throw new Error('User not found.');
		}
		const existing = await this.getCredentialsForUser(userId);
		const options = await buildRegistrationOptions({ user, existing });
		const challengeId = await this.createWebauthnChallenge({
			challenge: options.challenge,
			type: 'registration',
			userId: userId
		});
		return { options, challengeId };
	}

	/** Finish enrollment: verify the attestation, store the credential, and flip the account flag
	 * that tells the UI (via the account cookie) that biometric sign-in is available. */
	static async completePasskeyRegistration({ userId, challengeId, response }) {
		const pending = await this.consumeWebauthnChallenge(challengeId, 'registration');
		if (!pending || pending.userId !== userId) {
			throw new Error('That enrollment expired. Try again.');
		}
		const verified = await verifyRegistration({ response, expectedChallenge: pending.challenge });
		if (!verified) {
			throw new Error('Could not verify this device.');
		}
		await sequelize.transaction(async (transaction) => {
			await Credential.create({ ...verified, userId: userId }, { transaction });
			await User.update({ passkeyEnabled: true }, { where: { id: userId }, transaction });
		});
		return true;
	}

	static async beginPasskeyAuthentication() {
		const options = await buildAuthenticationOptions();
		const challengeId = await this.createWebauthnChallenge({
			challenge: options.challenge,
			type: 'authentication'
		});
		return { options, challengeId };
	}

	/** Finish sign-in. A verified assertion mints a session that is already 'satisfied': the
	 * authenticator proved possession of the device and verified the user on it, and the credential
	 * only exists because password + TOTP were cleared when it was enrolled. */
	static async completePasskeyAuthentication({ challengeId, response }) {
		const pending = await this.consumeWebauthnChallenge(challengeId, 'authentication');
		if (!pending) {
			throw new Error('That sign-in attempt expired. Try again.');
		}
		// Guard the lookup key: an absent or non-string id would reach Sequelize as an invalid WHERE
		// value and surface a driver error instead of a clean rejection.
		const credentialId = typeof response?.id === 'string' ? response.id : null;
		const credential = credentialId
			? await Credential.findOne({ where: { credentialId }, include: [User] })
			: null;
		if (!credential?.User) {
			throw new Error('This device is not enrolled.');
		}
		if (credential.User.isDisabled) {
			throw new Error('Invalid credentials.');
		}
		let verified = null;
		try {
			verified = await verifyAuthentication({ response, expectedChallenge: pending.challenge, credential });
		} catch (error) {
			// A counter that went backwards means a cloned authenticator; simplewebauthn throws
			// rather than returning false, and either way it's a failed sign-in.
			verified = null;
		}
		if (!verified) {
			throw new Error('Could not verify this device.');
		}
		credential.counter = verified.counter;
		credential.lastUsedAt = new Date();
		await credential.save();
		const user = await this.getUserById(credential.userId);
		const session = await this.createSession(user.id, 'satisfied');
		return { ...session, mfaState: 'satisfied', user };
	}

	/** Turn biometric sign-in off for the whole account. Every credential goes, on every device —
	 * this is also the lost-device switch, so leaving one behind would defeat the point. */
	static async disablePasskeys(userId) {
		await sequelize.transaction(async (transaction) => {
			await Credential.destroy({ where: { userId: userId }, transaction });
			await User.update({ passkeyEnabled: false }, { where: { id: userId }, transaction });
		});
		return true;
	}

	// Registers an account into the pending table and returns the verification token so the
	// caller can email it. No `users` row and no session are created here — the account
	// does not exist for login purposes until the link is clicked.
	static async createPendingUser({ email, name, password }) {
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
		await PendingUser.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
		const token = randomBytes(48).toString('hex');
		const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
		// Upsert keyed on the unique email: a repeat signup before verification (e.g. the first
		// email never arrived) overwrites the pending row in place, issuing a fresh token and
		// expiry and invalidating the previous link.
		await PendingUser.upsert({
			email: normalizedEmail,
			name: name || normalizedEmail,
			passwordHash: bcrypt.hashSync(password, PASSWORD_COST),
			verificationToken: token,
			expiresAt
		});
		return { email: normalizedEmail, name: name || normalizedEmail, token, expiresAt };
	}

	static async deletePendingUser(email) {
		const normalizedEmail = normalizeEmail(email);
		if (!normalizedEmail) {
			return false;
		}
		await PendingUser.destroy({ where: { email: normalizedEmail } });
		return true;
	}

	// Promotes a pending account into `users` and logs it in. The move and the pending-row
	// deletion run in one transaction so a verified account can never exist in both tables.
	static async verifyPendingUser(token) {
		if (!token) {
			throw new Error('This verification link is invalid or has expired.');
		}
		const pending = await PendingUser.findOne({
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
			const created = await User.create({
				email: pending.email,
				name: pending.name,
				// Reuse the hash captured at registration — the password is never re-collected.
				passwordHash: pending.passwordHash
			}, { transaction });
			await pending.destroy({ transaction });
			return created;
		});
		// A newly activated account has no TOTP yet — start the session gated so the app forces
		// mandatory enrollment before anything else is reachable.
		const session = await this.createSession(user.id, 'setup_required');
		return {
			...session,
			mfaState: 'setup_required',
			user: toPublicUser(user)
		};
	}

	static async getGroups() {
		const groups = await Group.findAll({
			include: [{
				model: User,
				through: { attributes: ['role'] },
				attributes: ['id', 'name', 'email']
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
				users: plain.Users?.map((user) => {
					return {
						id: user.id,
						email: user.email,
						name: user.name,
						role: user.UserGroup?.role || 'member'
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
		const memberships = await UserGroup.findAll({
			where: { userId: userId, role: 'manager' },
			attributes: ['groupId']
		});
		const groupIds = new Set(memberships.map((membership) => { return membership.groupId; }));
		if (groupIds.size === 0) {
			return [];
		}
		const groups = await this.getGroups();
		return groups.filter((group) => { return groupIds.has(group.id); });
	}

	/** Ids of a group's members, for targeting broadcasts when a node is shared with the group. */
	static async listGroupMemberUserIds(groupId) {
		const group = await Group.findByPk(groupId, {
			include: [{ model: User, attributes: ['id'], through: { attributes: [] } }]
		});
		if (!group) {
			return [];
		}
		return (group.Users || []).map((user) => { return user.id; });
	}

	/** String nodeIds of the nodes a group grants access to (via GroupNodeAccess). Captured before a
	 * group membership/existence change so access to those nodes can be re-evaluated and enforced. */
	static async listGroupNodeIds(groupId) {
		const group = await Group.findByPk(groupId, {
			include: [{ model: Node, attributes: ['nodeId'], through: { attributes: [] } }]
		});
		if (!group) {
			return [];
		}
		return (group.Nodes || []).map((node) => { return node.nodeId; });
	}

	static async createGroup({ name, description, createdByUserId }) {
		const normalizedName = String(name || '').trim();
		if (!normalizedName) {
			throw new Error('Group name is required.');
		}
		// Names are unique per creator, not globally: different users may each have a group with the
		// same name, but a single user cannot create two groups sharing a name.
		if (createdByUserId) {
			const existing = await Group.findOne({ where: { name: normalizedName, createdByUserId } });
			if (existing) {
				throw new Error('You already have a group with that name.');
			}
		}
		const group = await Group.create({
			name: normalizedName,
			description: description || null,
			createdByUserId: createdByUserId || null
		});
		if (createdByUserId) {
			const creator = await User.findByPk(createdByUserId);
			if (creator) {
				await group.addUser(creator, { through: { role: 'manager' } });
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
		const membership = await UserGroup.findOne({
			where: { userId: userId, groupId: groupId }
		});
		return membership?.role === 'manager';
	}

	static async updateGroup({ groupId, description, newName }) {
		const group = await Group.findByPk(groupId);
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
		const group = await Group.findByPk(groupId);
		if (!group) {
			throw new Error(`Group ${groupId} not found.`);
		}
		await group.destroy();
		return true;
	}

	static async addUserToGroup({ groupId, email, role = 'member' }) {
		const group = await Group.findByPk(groupId);
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.addUser(user, { through: { role } });
		return true;
	}

	static async removeUserFromGroup({ groupId, email }) {
		const group = await Group.findByPk(groupId);
		const user = await this.getUserByEmail(email);
		if (!group || !user) {
			throw new Error('Group or user not found.');
		}
		await group.removeUser(user);
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
		// Every registration mints a fresh token, so completing one invalidates the previous
		// credential: a token captured from an earlier registration stops working, and a node that
		// re-registers is the only holder of the new one. The node persists what the ack returns.
		if (!created) {
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

	/** Record a connectivity transition for a node, but only when it differs from the node's most
	 * recent recorded state — redundant same-state events (e.g. a reconnect that never registered a
	 * disconnect) would just bloat the table without adding information to the bar. */
	static async recordConnectivityEvent(nodeId, online) {
		const normalizedNodeId = String(nodeId || '').trim();
		if (!normalizedNodeId) {
			return;
		}
		const last = await NodeConnectivityEvent.findOne({
			where: { nodeId: normalizedNodeId },
			order: [['createdAt', 'DESC']]
		});
		if (last && last.online === Boolean(online)) {
			return;
		}
		await NodeConnectivityEvent.create({ nodeId: normalizedNodeId, online: Boolean(online) });
	}

	/** All retained connectivity events for the given nodes, oldest first. Volume stays small
	 * because pruneConnectivityEvents caps history at the retention window (plus one seed per node),
	 * so the caller can group in memory and hand each node's events to buildConnectivitySegments. */
	static async getConnectivityEvents(nodeIds) {
		const ids = (nodeIds || []).map((id) => { return String(id || '').trim(); }).filter(Boolean);
		if (ids.length === 0) {
			return [];
		}
		const events = await NodeConnectivityEvent.findAll({
			where: { nodeId: { [Op.in]: ids } },
			attributes: ['nodeId', 'online', 'createdAt'],
			order: [['createdAt', 'ASC']]
		});
		return events.map((event) => {
			const plain = event.get({ plain: true });
			return { nodeId: plain.nodeId, online: plain.online, createdAt: plain.createdAt };
		});
	}

	/** Trim connectivity history to the retained window, keeping per node the single most recent
	 * event at-or-before the cutoff (the "seed" for the current standing state) plus everything
	 * newer, and deleting only the pre-cutoff events that seed supersedes. A node whose state has
	 * not changed in a long time keeps that last transition even if it is far older than the cutoff,
	 * so we can always tell what state it is in and since when. (id is autoincrement, hence monotonic
	 * with insertion time, so MAX(id) per node picks that most-recent pre-cutoff event.) */
	static async pruneConnectivityEvents() {
		const cutoff = new Date(Date.now() - CONNECTIVITY_RETENTION_MS);
		const seeds = await NodeConnectivityEvent.findAll({
			attributes: [[sequelize.fn('MAX', sequelize.col('id')), 'id']],
			where: { createdAt: { [Op.lte]: cutoff } },
			group: ['nodeId'],
			raw: true
		});
		const seedIds = seeds.map((row) => { return row.id; });
		await NodeConnectivityEvent.destroy({
			where: {
				createdAt: { [Op.lte]: cutoff },
				...(seedIds.length ? { id: { [Op.notIn]: seedIds } } : {})
			}
		});
	}

	static async grantNodeAccess({ email, nodeId, role = 'admin' }) {
		const user = await this.getUserByEmail(email);
		const node = await Node.findOne({ where: { nodeId } });
		if (!user || !node) {
			throw new Error('User or node not found.');
		}
		await node.addUser(user, { through: { role } });
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
		await node.removeUser(user);
		return true;
	}

	static async grantGroupNodeAccess({ groupId, nodeId }) {
		const group = await Group.findByPk(groupId);
		const node = await Node.findOne({ where: { nodeId } });
		if (!group || !node) {
			throw new Error('Group or node not found.');
		}
		await group.addNode(node);
		return true;
	}

	static async revokeGroupNodeAccess({ groupId, nodeId }) {
		const group = await Group.findByPk(groupId);
		const node = await Node.findOne({ where: { nodeId } });
		if (!group || !node) {
			throw new Error('Group or node not found.');
		}
		await group.removeNode(node);
		return true;
	}

	/** After a node is shared with a group, collapse redundant direct grants: a user who was an
	 * invited admin AND is a member of that group now reaches the node through the group, so their
	 * direct NodeAccess row is dropped and their access is represented once (by the group). The owner
	 * row is never touched, and admins who are NOT in the group keep their direct grant. No one loses
	 * access — the group still covers the removed users — so no session teardown is needed. Returns
	 * the ids of users whose direct grant was collapsed. */
	static async collapseDirectAdminsIntoGroup(nodeId, groupId) {
		const [node, group] = await Promise.all([
			Node.findOne({
				where: { nodeId },
				include: [{ model: User, attributes: ['id'], through: { attributes: ['role'] } }]
			}),
			Group.findByPk(groupId, {
				include: [{ model: User, attributes: ['id'], through: { attributes: [] } }]
			})
		]);
		if (!node || !group) {
			return [];
		}
		const groupMemberIds = new Set((group.Users || []).map((user) => { return user.id; }));
		const redundant = (node.Users || []).filter((user) => {
			return user.id !== node.ownerUserId && user.NodeAccess?.role !== 'owner' && groupMemberIds.has(user.id);
		});
		if (redundant.length) {
			await node.removeUsers(redundant);
		}
		return redundant.map((user) => { return user.id; });
	}

	static async listAccessibleNodes(userId) {
		const user = await User.findByPk(userId, {
			include: [{
				model: Group,
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
		for (const group of user.Groups || []) {
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
					model: User,
					through: { attributes: ['role'] }
				},
				{
					model: Group,
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
			users: (plain.Users || []).map((user) => {
				return {
					email: user.email,
					name: user.name,
					role: user.NodeAccess?.role || 'admin'
				};
			}),
			groups: (plain.Groups || []).map((group) => {
				return { id: group.id, name: group.name };
			})
		};
	}

	/** Ids of every user with access to a node (owner + directly-invited members), for targeting
	 * inventory broadcasts. Capture this before a removal so the user losing access is still included. */
	static async listNodeMemberUserIds(nodeId) {
		const node = await Node.findOne({
			where: { nodeId },
			include: [{ model: User, attributes: ['id'], through: { attributes: [] } }]
		});
		if (!node) {
			return [];
		}
		const ids = new Set();
		if (node.ownerUserId) {
			ids.add(node.ownerUserId);
		}
		for (const user of node.Users || []) {
			ids.add(user.id);
		}
		return [...ids];
	}

	static async getNodeName(nodeId) {
		const node = await Node.findOne({ where: { nodeId }, attributes: ['name'] });
		return node?.name || null;
	}

	/** Signature of the update set the node's members were last notified about (empty string when the
	 * node last reported no updates, null when never recorded). Persisted so reconnect re-reports and
	 * process restarts don't re-notify. */
	static async getNodeUpdateSignature(nodeId) {
		const node = await Node.findOne({ where: { nodeId }, attributes: ['lastUpdateSignature'] });
		return node?.lastUpdateSignature ?? null;
	}

	static async setNodeUpdateSignature(nodeId, signature) {
		await Node.update({ lastUpdateSignature: signature }, { where: { nodeId } });
	}

	/** Signature of the per-pool health states the node's members were last notified about (null when
	 * never recorded). Persisted so poll re-reports and process restarts don't re-notify. */
	static async getNodeStorageSignature(nodeId) {
		const node = await Node.findOne({ where: { nodeId }, attributes: ['lastStorageSignature'] });
		return node?.lastStorageSignature ?? null;
	}

	static async setNodeStorageSignature(nodeId, signature) {
		await Node.update({ lastStorageSignature: signature }, { where: { nodeId } });
	}

	/** Upsert a browser's push subscription, keyed by its endpoint. A re-subscribe from the same
	 * install carries the same endpoint, so we refresh its keys and (re)assign it to this user rather
	 * than creating a duplicate. */
	static async savePushSubscription(userId, subscription) {
		const endpoint = subscription?.endpoint;
		const p256dh = subscription?.keys?.p256dh;
		const auth = subscription?.keys?.auth;
		if (!endpoint || !p256dh || !auth) {
			throw new Error('Invalid push subscription.');
		}
		const [row, created] = await PushSubscription.findOrCreate({
			where: { endpoint },
			defaults: { endpoint, p256dh, auth, userId: userId }
		});
		if (!created) {
			await row.update({ p256dh, auth, userId: userId });
		}
		return row;
	}

	static async deletePushSubscription(endpoint) {
		if (!endpoint) {
			return;
		}
		await PushSubscription.destroy({ where: { endpoint } });
	}

	// Turning notifications off is account-wide, so drop every device's subscription in one go.
	static async deletePushSubscriptionsForUser(userId) {
		await PushSubscription.destroy({ where: { userId: userId } });
	}

	// Account-level intent to receive notifications; read by each device on load to decide whether to
	// obtain its own permission.
	static async setUserPushEnabled(userId, enabled) {
		await User.update({ pushEnabled: Boolean(enabled) }, { where: { id: userId } });
	}

	static async listPushSubscriptionsForUsers(userIds) {
		if (!userIds?.length) {
			return [];
		}
		return PushSubscription.findAll({ where: { userId: { [Op.in]: userIds } } });
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

	/** User ids whose accessible-node inventory changes when `userId` is deleted, so the nodes:updated
	 * broadcast can target exactly them instead of every connected user. Must be computed BEFORE the
	 * deletion, because the DB cascade removes the rows it derives from. Three affected sets:
	 *  - everyone who can currently see a node this user owns — owner + directly-invited members +
	 *    members of any group the node is shared with (the owned nodes are cascade-deleted);
	 *  - members of every group this user created — those groups cascade away too, dropping the nodes
	 *    they shared with the members;
	 *  - the owners of nodes this user is an invited admin on — an owner's inventory lists their node's
	 *    admins, so removing this user changes that list and the owner must be refreshed.
	 * The user themselves is excluded: they're being removed, so there's nothing to refresh. */
	static async listUsersAffectedByUserDeletion(userId) {
		if (!userId) {
			return [];
		}
		const affected = new Set();

		const ownedNodes = await Node.findAll({
			where: { ownerUserId: userId },
			include: [
				{ model: User, attributes: ['id'], through: { attributes: [] } },
				{
					model: Group,
					attributes: ['id'],
					include: [{ model: User, attributes: ['id'], through: { attributes: [] } }]
				}
			]
		});
		for (const node of ownedNodes) {
			if (node.ownerUserId) {
				affected.add(node.ownerUserId);
			}
			for (const user of node.Users || []) {
				affected.add(user.id);
			}
			for (const group of node.Groups || []) {
				for (const user of group.Users || []) {
					affected.add(user.id);
				}
			}
		}

		const createdGroups = await Group.findAll({
			where: { createdByUserId: userId },
			include: [{ model: User, attributes: ['id'], through: { attributes: [] } }]
		});
		for (const group of createdGroups) {
			for (const user of group.Users || []) {
				affected.add(user.id);
			}
		}

		// Owners of nodes this user is an invited admin on: their admins list reflects this user, so
		// they must be refreshed when the user is removed. (Owned nodes are already covered above.)
		for (const ownerId of await this.listNodeOwnersForMember(userId)) {
			affected.add(ownerId);
		}

		affected.delete(userId);
		return [...affected];
	}

	/** Owner ids of the nodes `userId` is an invited member of, excluding the user's own nodes. An
	 * owner's inventory renders that node's admins list (each admin's email + name), so these
	 * owners must be refreshed whenever the member changes in a way that list reflects — being removed
	 * (deletion) or renamed (update). Group-only access never appears in an admins list, so members
	 * reached only through a group share are intentionally excluded. */
	static async listNodeOwnersForMember(userId) {
		if (!userId) {
			return [];
		}
		const nodes = await Node.findAll({
			attributes: ['ownerUserId'],
			include: [{
				model: User,
				attributes: [],
				through: { attributes: [] },
				where: { id: userId }
			}]
		});
		const owners = new Set();
		for (const node of nodes) {
			if (node.ownerUserId && node.ownerUserId !== userId) {
				owners.add(node.ownerUserId);
			}
		}
		return [...owners];
	}

	static async deleteNode(nodeId) {
		const node = await Node.findOne({ where: { nodeId } });
		if (!node) {
			throw new Error(`Node ${nodeId} not found.`);
		}
		await node.setUsers([]);
		await node.setGroups([]);
		await node.destroy();
		return true;
	}
}

export default DataService;
