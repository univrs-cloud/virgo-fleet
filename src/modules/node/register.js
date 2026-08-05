import DataService from '../../services/data_service.js';
import { createRateLimiter, getSocketClientAddress } from '../../utils/socket_rate_limit.js';

// node:register is reachable without authentication, verifies fleet credentials and claims a node
// id, so it is both a credential-stuffing surface and the way node ids get enumerated. Limits are
// set well above a rack rollout (many nodes sharing one NAT address and one fleet account) while
// still capping enumeration; the address bucket catches many accounts from one client, the email
// bucket catches one account spread across many clients.
const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const addressRateLimiter = createRateLimiter({ windowMs: REGISTER_WINDOW_MS, max: 30 });
const emailRateLimiter = createRateLimiter({ windowMs: REGISTER_WINDOW_MS, max: 30 });
const RATE_LIMITED_MESSAGE = 'Too many registration attempts, please try again later.';

const onConnection = (socket, module) => {
	if (socket.data?.role !== 'node') {
		return;
	}

	socket.on('node:register', async (config, ack = () => {}) => {
		try {
			if (!addressRateLimiter.consume(getSocketClientAddress(socket))) {
				ack({ status: 'failed', message: RATE_LIMITED_MESSAGE });
				return;
			}
			const serialNumber = String(config?.serialNumber || config?.nodeId || '').trim();
			const name = String(config?.name || '').trim() || serialNumber;
			const email = String(config?.email || '').trim().toLowerCase();
			const password = String(config?.password || '');
			if (!serialNumber || !email || !password) {
				ack({ status: 'failed', message: 'serialNumber, email and password are required.' });
				return;
			}
			if (!emailRateLimiter.consume(email)) {
				ack({ status: 'failed', message: RATE_LIMITED_MESSAGE });
				return;
			}
			const owner = await DataService.verifyCredentials({ email, password });
			if (!owner) {
				ack({ status: 'failed', message: 'Invalid fleet credentials.' });
				return;
			}
			const node = await DataService.upsertNode({
				nodeId: serialNumber,
				name,
				ownerUserId: owner.id
			});
			await DataService.grantNodeAccess({
				email: owner.email,
				nodeId: serialNumber,
				role: 'owner'
			});
			socket.data.nodeId = serialNumber;
			module.setNodeSocket(serialNumber, socket);
			module.eventEmitter.emit('nodes:updated', { userIds: [owner.id] });
			ack({ status: 'succeeded', nodeId: serialNumber, token: node.token });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'register',
	onConnection
};
