import DomainService from '../../services/domain_service.js';

const onConnection = (socket) => {
	if (socket.data?.role !== 'node' || !socket.data?.nodeId) {
		return;
	}

	socket.on('acme:present', async ({ fqdn, value } = {}, ack = () => {}) => {
		try {
			if (!fqdn || !value) {
				ack({ status: 'failed', message: 'fqdn and value are required' });
				return;
			}

			await DomainService.present(socket.data.nodeId, fqdn, value);
			ack({ status: 'succeeded' });
		} catch (error) {
			console.error(`[acme] present failed for ${socket.data.nodeId}: ${error.message}`);
			ack({ status: 'failed', message: error.message });
		}
	});

	socket.on('acme:cleanup', async ({ fqdn, value } = {}, ack = () => {}) => {
		try {
			if (!fqdn || !value) {
				ack({ status: 'failed', message: 'fqdn and value are required' });
				return;
			}

			await DomainService.cleanup(socket.data.nodeId, fqdn, value);
			ack({ status: 'succeeded' });
		} catch (error) {
			console.error(`[acme] cleanup failed for ${socket.data.nodeId}: ${error.message}`);
			ack({ status: 'failed', message: error.message });
		}
	});
};

export default {
	name: 'acme',
	onConnection
};
