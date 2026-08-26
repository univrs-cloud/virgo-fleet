import DomainService from '../../services/domain_service.js';
import { createRateLimiter, getSocketClientAddress } from '../../utils/socket_rate_limit.js';

const AVAILABILITY_WINDOW_MS = 15 * 60 * 1000;
const availabilityRateLimiter = createRateLimiter({ windowMs: AVAILABILITY_WINDOW_MS, max: 120 });

const onConnection = (socket) => {
	if (socket.data?.role !== 'node') {
		return;
	}

	socket.on('node:domain:claim', async ({ hostname, domainName, address } = {}, ack = () => {}) => {
		if (!socket.data?.nodeId) {
			ack({ status: 'failed', message: 'Unauthorized' });
			return;
		}

		try {
			const publicIp = getSocketClientAddress(socket);
			const domain = await DomainService.claim({ nodeId: socket.data.nodeId, hostname, domainName, address, publicIp });
			if (domain) {
				await DomainService.syncRecords(socket.data.nodeId, publicIp);
			}

			ack({ status: 'succeeded', fqdn: domain?.fqdn || null });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('node:domain:availability', async ({ label } = {}, ack = () => {}) => {
		try {
			if (!availabilityRateLimiter.consume(getSocketClientAddress(socket))) {
				ack({ status: 'failed', message: 'Too many availability checks, please try again later.' });
				return;
			}

			const result = await DomainService.isAvailable(label);
			ack({ status: 'succeeded', zone: DomainService.getZone(), ...result });
		} catch (error) {
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'domain',
	onConnection
};
