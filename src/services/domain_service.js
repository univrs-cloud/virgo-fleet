import tls from 'tls';
import { Op } from 'sequelize';
import { NodeDomain, AcmeChallenge } from '../database/models/associations.js';
import CloudflareService from './cloudflare.js';

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_LABELS = new Set([
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

	static async isAvailable(label) {
		const normalized = this.normalizeLabel(label);
		if (!normalized || !LABEL_PATTERN.test(normalized)) {
			return { available: false, reason: 'invalid' };
		}

		if (RESERVED_LABELS.has(normalized)) {
			return { available: false, reason: 'reserved' };
		}

		const taken = await NodeDomain.findOne({ where: { fqdn: `${normalized}.${this.getZone()}` } });
		return taken ? { available: false, reason: 'taken' } : { available: true };
	}

	static async claim({ nodeId, hostname, domainName, address, publicIp }) {
		const zone = this.getZone();
		const label = this.normalizeLabel(hostname);
		if (!zone) {
			console.warn(`[domains] ${nodeId}: no CLOUDFLARE_ZONE configured, skipping claim.`);
			return null;
		}

		if (this.normalizeLabel(domainName) !== zone) {
			console.warn(`[domains] ${nodeId}: domain '${domainName}' is not the managed zone '${zone}', skipping claim.`);
			return null;
		}

		if (!label) {
			console.warn(`[domains] ${nodeId}: no hostname reported, skipping claim.`);
			return null;
		}

		const fqdn = `${label}.${zone}`;
		const existing = await NodeDomain.findOne({ where: { nodeId } });
		const availability = await this.isAvailable(label);
		if (!availability.available && existing?.fqdn !== fqdn) {
			throw new Error(availability.reason === 'taken' ? `${fqdn} is already taken.` : `${label} is not a usable name.`);
		}

		const probed = (this.isPublicAddress(address) ? 'public' : await this.probeTarget(fqdn, publicIp));
		const target = (existing?.target === 'public' ? 'public' : probed);
		if (!existing) {
			return NodeDomain.create({ nodeId, label, fqdn, lanIp: address, publicIp: (this.isPublicAddress(publicIp) ? publicIp : null), target });
		}

		const renamed = existing.fqdn !== fqdn;
		if (renamed) {
			await this.releaseRecords(existing);
		}

		existing.label = label;
		existing.fqdn = fqdn;
		existing.lanIp = address || existing.lanIp;
		existing.publicIp = (this.isPublicAddress(publicIp) ? publicIp : existing.publicIp);
		existing.target = target;
		await existing.save();
		return existing;
	}

	static async syncRecords(nodeId, publicIp) {
		const domain = await NodeDomain.findOne({ where: { nodeId } });
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
		await this.replaceConflicting(domain.fqdn, 'A');
		await this.replaceConflicting(wildcard, 'A');
		domain.recordIds = {
			apex: await CloudflareService.upsertA(domain.fqdn, address),
			wildcard: await CloudflareService.upsertA(wildcard, address)
		};
		await domain.save();
		console.log(`[domains] ${domain.fqdn} and ${wildcard} point at ${address} (${domain.target}).`);
		return domain;
	}

	/** Cleanup runs before lego has the certificate, so probing immediately would still find nothing
	 * to match. The delay lets traefik store and serve it first; the timer is per node so the two
	 * cleanups of a wildcard order collapse into one probe. */
	static scheduleReprobe(nodeId, publicIp) {
		clearTimeout(pendingReprobes.get(nodeId));
		const timer = setTimeout(() => {
			pendingReprobes.delete(nodeId);
			this.reprobe(nodeId, publicIp).catch((error) => { console.error(`[domains] reprobe failed for ${nodeId}: ${error.message}`); });
		}, REPROBE_DELAY_MS);
		timer.unref();
		pendingReprobes.set(nodeId, timer);
	}

	static async reprobe(nodeId, publicIp) {
		const domain = await NodeDomain.findOne({ where: { nodeId } });
		if (!domain || !publicIp) {
			return null;
		}

		const target = await this.probeTarget(domain.fqdn, publicIp);
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

	static async releaseRecords(domain) {
		await CloudflareService.deleteRecords(Object.values(domain.recordIds || {}));
		domain.recordIds = {};
		await domain.save();
	}

	static async release(nodeId) {
		const domain = await NodeDomain.findOne({ where: { nodeId } });
		if (!domain) {
			return;
		}

		await this.releaseRecords(domain);
		await this.cleanupAll(nodeId);
		await domain.destroy();
	}

	static async authorize(nodeId, name) {
		const domain = await NodeDomain.findOne({ where: { nodeId } });
		if (!domain) {
			throw new Error('This node has no claimed domain.');
		}

		const normalized = this.normalizeName(name);
		if (!normalized.startsWith(CHALLENGE_PREFIX)) {
			throw new Error('Only _acme-challenge records can be requested.');
		}

		const subject = normalized.slice(CHALLENGE_PREFIX.length);
		if (subject !== domain.fqdn && !subject.endsWith(`.${domain.fqdn}`)) {
			throw new Error(`${normalized} is outside this node's domain.`);
		}

		return domain;
	}

	static async present(nodeId, name, value) {
		await this.authorize(nodeId, name);
		const since = new Date(Date.now() - ISSUANCE_WINDOW_MS);
		const recent = await AcmeChallenge.count({ where: { nodeId, createdAt: { [Op.gte]: since } } });
		if (recent >= ISSUANCE_LIMIT) {
			throw new Error('Too many certificate requests this week for this node.');
		}

		const normalized = this.normalizeName(name);
		const recordId = await CloudflareService.createTxt(normalized, value);
		await AcmeChallenge.create({ nodeId, name: normalized, value, recordId });
		return recordId;
	}

	static async cleanup(nodeId, name, value) {
		const normalized = this.normalizeName(name);
		const challenges = await AcmeChallenge.findAll({ where: { nodeId, name: normalized, value } });
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
