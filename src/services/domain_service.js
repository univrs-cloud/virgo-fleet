import tls from 'tls';
import { Op } from 'sequelize';
import { Node, Cluster, ClusterMember, AcmeChallenge } from '../database/models/associations.js';
import CloudflareService from './cloudflare.js';

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_CLUSTER_NAMES = new Set([
	'fleet', 'apps', 'packages', 'www', 'api', 'auth', 'admin', 'mail', 'smtp', 'imap',
	'ns', 'ns1', 'ns2', 'mx', 'traefik', 'status', 'docs', 'blog', 'cdn', 'static'
]);
const CHALLENGE_PREFIX = '_acme-challenge.';
const ISSUANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUANCE_LIMIT = 12;
const PROBE_TIMEOUT_MS = 5000;
const REPROBE_DELAY_MS = 60000;
const pendingReprobes = new Map();
const PRIVATE_ADDRESS = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

class DomainService {
	static getZone() {
		return CloudflareService.getZone();
	}

	static normalizeLabel(label) {
		return String(label || '').trim().toLowerCase();
	}

	static normalizeName(name) {
		return String(name || '').trim().toLowerCase().replace(/\.$/, '');
	}

	static getZoneLabel(domainName) {
		const zone = this.getZone();
		const domain = this.normalizeName(domainName);
		return (zone && domain.endsWith(`.${zone}`) ? domain.slice(0, -(zone.length + 1)) : '');
	}

	static isOnZone(domainName) {
		const zone = this.getZone();
		return Boolean(zone) && (this.normalizeName(domainName) === zone || LABEL_PATTERN.test(this.getZoneLabel(domainName)));
	}

	static parseIdentifier(hostname, domainName) {
		const zone = this.getZone();
		const nodeFqdn = this.normalizeName(`${hostname}.${domainName}`);
		if (!zone || !nodeFqdn.endsWith(`.${zone}`)) {
			return null;
		}

		const labels = nodeFqdn.slice(0, -(zone.length + 1)).split('.');
		if (!labels.every((label) => { return LABEL_PATTERN.test(label); })) {
			return null;
		}

		if (labels.length === 1) {
			return { label: labels[0], fqdn: nodeFqdn, nodeFqdn };
		}

		if (labels.length === 2) {
			return { label: labels[1], fqdn: `${labels[1]}.${zone}`, nodeFqdn };
		}

		return null;
	}

	static async getMembership(nodeId) {
		return ClusterMember.findOne({ where: { nodeId }, include: [Cluster] });
	}

	static async hasLegacyMember(cluster) {
		const members = await ClusterMember.findAll({ where: { clusterId: cluster.id }, include: [{ model: Node, attributes: ['name', 'domainName'] }] });
		return members.some((member) => {
			const identifier = (member.Node?.domainName ? this.parseIdentifier(member.Node.name, member.Node.domainName) : null);
			return (!identifier || identifier.nodeFqdn === cluster.fqdn);
		});
	}

	static async leaveCluster(membership) {
		const cluster = membership.Cluster;
		await membership.destroy();
		if (!await ClusterMember.count({ where: { clusterId: cluster.id } })) {
			await CloudflareService.deleteRecords(Object.values(cluster.recordIds || {}));
			await cluster.destroy();
		}
	}

	static async getIdentifier(nodeId) {
		const node = await Node.findOne({ where: { nodeId }, attributes: ['name', 'domainName'] });
		return (node?.domainName ? this.parseIdentifier(node.name, node.domainName) : null);
	}

	static isPublicAddress(address) {
		const value = String(address || '').trim();
		return Boolean(value) && !PRIVATE_ADDRESS.test(value);
	}

	static matchesCertificate(fqdn, certificate) {
		const names = String(certificate?.subjectaltname || '')
			.split(',')
			.map((entry) => { return entry.trim().replace(/^DNS:/, '').toLowerCase(); })
			.filter(Boolean);
		return names.some((name) => {
			return name === fqdn || (name.startsWith('*.') && fqdn.endsWith(name.slice(1)) && fqdn.split('.').length === name.split('.').length);
		});
	}

	/** Both nodes on one LAN share an egress address, so reachability alone cannot say which of them
	 * the router forwards to. The probe asks for the node's own name and checks the certificate that
	 * comes back covers it, so a node answering for someone else does not count as reachable. */
	static probeTarget(fqdn, publicIp) {
		return new Promise((resolve) => {
			if (!publicIp || !this.isPublicAddress(publicIp)) {
				resolve('lan');
				return;
			}

			const socket = tls.connect({
				host: publicIp,
				port: 443,
				servername: fqdn,
				rejectUnauthorized: false,
				timeout: PROBE_TIMEOUT_MS
			}, () => {
				const matched = this.matchesCertificate(fqdn, socket.getPeerCertificate());
				socket.destroy();
				resolve(matched ? 'public' : 'lan');
			});
			socket.on('timeout', () => { socket.destroy(); resolve('lan'); });
			socket.on('error', () => { socket.destroy(); resolve('lan'); });
		});
	}

	static async isAvailable(label, nodeId) {
		const normalized = this.normalizeLabel(label);
		if (!normalized || !LABEL_PATTERN.test(normalized)) {
			return { available: false, reason: 'invalid' };
		}

		if (RESERVED_CLUSTER_NAMES.has(normalized)) {
			return { available: false, reason: 'reserved' };
		}

		const cluster = await Cluster.findOne({ where: { fqdn: `${normalized}.${this.getZone()}` } });
		if (!cluster) {
			return { available: true };
		}

		if (!nodeId) {
			return { available: true, reason: 'existing' };
		}

		const node = await Node.findOne({ where: { nodeId }, attributes: ['ownerUserId'] });
		if (node && node.ownerUserId === cluster.ownerUserId) {
			return { available: true, reason: 'existing' };
		}

		return { available: false, reason: 'taken' };
	}

	static async claim({ nodeId, hostname, domainName, address, publicIp }) {
		const zone = this.getZone();
		if (!zone) {
			console.warn(`[domains] ${nodeId}: no CLOUDFLARE_ZONE configured, skipping claim.`);
			return null;
		}

		if (!this.isOnZone(domainName)) {
			console.warn(`[domains] ${nodeId}: domain '${domainName}' is not under the managed zone '${zone}', skipping claim.`);
			return null;
		}

		if (!this.normalizeLabel(hostname)) {
			console.warn(`[domains] ${nodeId}: no hostname reported, skipping claim.`);
			return null;
		}

		const identifier = this.parseIdentifier(hostname, domainName);
		if (!identifier) {
			console.warn(`[domains] ${nodeId}: '${hostname}.${domainName}' is not a usable name, skipping claim.`);
			return null;
		}

		const { label, fqdn, nodeFqdn } = identifier;
		const membership = await this.getMembership(nodeId);
		const joined = (membership?.Cluster?.fqdn === fqdn);
		let cluster = await Cluster.findOne({ where: { fqdn } });
		if (!joined) {
			const availability = await this.isAvailable(label, nodeId);
			if (!availability.available || (cluster && nodeFqdn === fqdn)) {
				throw new Error(['invalid', 'reserved'].includes(availability.reason) ? `${label} is not a usable name.` : `${fqdn} is already taken.`);
			}
		}

		if (membership && !joined) {
			await this.leaveCluster(membership);
		}

		const probed = (this.isPublicAddress(address) ? 'public' : await this.probeTarget(nodeFqdn, publicIp));
		if (!cluster) {
			const node = await Node.findOne({ where: { nodeId }, attributes: ['ownerUserId'] });
			cluster = await Cluster.create({ label, fqdn, ownerUserId: (node?.ownerUserId ?? null), lanIp: (address || null), publicIp: (this.isPublicAddress(publicIp) ? publicIp : null), target: probed });
		} else {
			cluster.lanIp = (address || cluster.lanIp);
			cluster.publicIp = (this.isPublicAddress(publicIp) ? publicIp : cluster.publicIp);
			cluster.target = (cluster.target === 'public' ? 'public' : probed);
			await cluster.save();
		}

		if (!joined) {
			await ClusterMember.create({ clusterId: cluster.id, nodeId });
		}

		return cluster;
	}

	static async syncRecords(nodeId, publicIp) {
		const domain = (await this.getMembership(nodeId))?.Cluster;
		if (!domain) {
			return null;
		}

		if (this.isPublicAddress(publicIp)) {
			domain.publicIp = publicIp;
		}

		const address = (domain.target === 'public' ? (domain.publicIp || domain.lanIp) : domain.lanIp);
		if (!address) {
			console.warn(`[domains] ${nodeId}: no address reported, ${domain.fqdn} has no A records.`);
			return domain;
		}

		const wildcard = `*.${domain.fqdn}`;
		await this.replaceConflicting(wildcard, 'A');
		const recordIds = { wildcard: await CloudflareService.upsertA(wildcard, address) };
		if (await this.hasLegacyMember(domain)) {
			await this.replaceConflicting(domain.fqdn, 'A');
			recordIds.apex = await CloudflareService.upsertA(domain.fqdn, address);
		} else {
			await CloudflareService.deleteRecord(domain.recordIds?.apex);
		}

		domain.recordIds = recordIds;
		await domain.save();
		console.log(`[domains] ${(recordIds.apex ? `${domain.fqdn} and ` : '')}${wildcard} point at ${address} (${domain.target}).`);
		return domain;
	}

	/** Cleanup runs before lego has the certificate, so probing immediately would still find nothing
	 * to match. The delay lets traefik store and serve it first; the timer is per node so the two
	 * cleanups of a wildcard order collapse into one probe. */
	static scheduleReprobe(nodeId, publicIp) {
		clearTimeout(pendingReprobes.get(nodeId));
		const timer = setTimeout(async () => {
			pendingReprobes.delete(nodeId);
			try {
				await this.reprobe(nodeId, publicIp);
			} catch (error) {
				console.error(`[domains] reprobe failed for ${nodeId}: ${error.message}`);
			}
		}, REPROBE_DELAY_MS);
		timer.unref();
		pendingReprobes.set(nodeId, timer);
	}

	static async reprobe(nodeId, publicIp) {
		const domain = (await this.getMembership(nodeId))?.Cluster;
		if (!domain || !publicIp) {
			return null;
		}

		const target = await this.probeTarget(((await this.getIdentifier(nodeId))?.nodeFqdn || domain.fqdn), publicIp);
		if (target !== 'public' || domain.target === 'public') {
			return domain;
		}

		console.log(`[domains] ${domain.fqdn} is now reachable as '${target}'.`);
		domain.target = target;
		domain.publicIp = publicIp;
		await domain.save();
		return this.syncRecords(nodeId, publicIp);
	}

	static async replaceConflicting(name, keep) {
		const existing = await CloudflareService.findRecords({ name });
		for (const record of existing.filter((record) => { return record.type !== keep && ['A', 'AAAA', 'CNAME'].includes(record.type); })) {
			console.log(`[domains] replacing the ${record.type} record at ${name}.`);
			await CloudflareService.deleteRecord(record.id);
		}
	}

	static async listDomains(nodeIds) {
		const members = await ClusterMember.findAll({ where: { nodeId: { [Op.in]: nodeIds } }, include: [Cluster, { model: Node, attributes: ['name', 'domainName'] }] });
		return new Map(members.map((member) => {
			const nodeFqdn = (member.Node?.domainName ? this.parseIdentifier(member.Node.name, member.Node.domainName)?.nodeFqdn : null);
			return [member.nodeId, { fqdn: member.Cluster.fqdn, nodeFqdn: (nodeFqdn || member.Cluster.fqdn) }];
		}));
	}

	static async release(nodeId) {
		const membership = await this.getMembership(nodeId);
		if (!membership) {
			return;
		}

		await this.leaveCluster(membership);
		await this.cleanupAll(nodeId);
	}

	static async releaseOwnedBy(userId) {
		const nodes = await Node.findAll({ where: { ownerUserId: userId }, attributes: ['nodeId'] });
		for (const node of nodes) {
			await this.release(node.nodeId);
		}

		for (const cluster of await Cluster.findAll({ where: { ownerUserId: userId } })) {
			await CloudflareService.deleteRecords(Object.values(cluster.recordIds || {}));
			await cluster.destroy();
		}
	}

	static async authorize(nodeId, name) {
		const domain = (await this.getMembership(nodeId))?.Cluster;
		if (!domain) {
			throw new Error('This node has no claimed domain.');
		}

		const identifier = await this.getIdentifier(nodeId);
		const nodeFqdn = (identifier?.fqdn === domain.fqdn ? identifier.nodeFqdn : domain.fqdn);
		const allowed = [...new Set([domain.fqdn, nodeFqdn])].map((allowedName) => { return `${CHALLENGE_PREFIX}${allowedName}`; });
		const requested = this.normalizeName(name);
		if (!allowed.includes(requested)) {
			throw new Error(`Only ${allowed.join(' and ')} can be requested by this node.`);
		}

		return { domain, name: requested };
	}

	static async present(nodeId, name, value) {
		const { name: challenge } = await this.authorize(nodeId, name);
		const since = new Date(Date.now() - ISSUANCE_WINDOW_MS);
		const recent = await AcmeChallenge.count({ where: { nodeId, createdAt: { [Op.gte]: since } } });
		if (recent >= ISSUANCE_LIMIT) {
			throw new Error('Too many certificate requests this week for this node.');
		}

		const recordId = await CloudflareService.createTxt(challenge, value);
		await AcmeChallenge.create({ nodeId, name: challenge, value, recordId });
		return recordId;
	}

	static async cleanup(nodeId, name, value) {
		const { name: challenge } = await this.authorize(nodeId, name);
		const challenges = await AcmeChallenge.findAll({ where: { nodeId, name: challenge, value } });
		for (const challenge of challenges) {
			await CloudflareService.deleteRecord(challenge.recordId);
			await challenge.destroy();
		}

		return challenges.length;
	}

	static async cleanupAll(nodeId) {
		const challenges = await AcmeChallenge.findAll({ where: { nodeId } });
		for (const challenge of challenges) {
			await CloudflareService.deleteRecord(challenge.recordId);
			await challenge.destroy();
		}
	}
}

export default DomainService;
