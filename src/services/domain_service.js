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

	static async claim({ nodeId, hostname, domainName, address }) {
		const zone = this.getZone();
		const label = this.normalizeLabel(hostname);
		if (!zone || this.normalizeLabel(domainName) !== zone) {
			return null;
		}

		const fqdn = `${label}.${zone}`;
		const existing = await NodeDomain.findOne({ where: { nodeId } });
		const availability = await this.isAvailable(label);
		if (!availability.available && existing?.fqdn !== fqdn) {
			throw new Error(availability.reason === 'taken' ? `${fqdn} is already taken.` : `${label} is not a usable name.`);
		}

		const target = (this.isPublicAddress(address) ? 'public' : 'lan');
		if (!existing) {
			return NodeDomain.create({ nodeId, label, fqdn, lanIp: address, target });
		}

		const renamed = existing.fqdn !== fqdn;
		if (renamed) {
			await this.releaseRecords(existing);
		}

		existing.label = label;
		existing.fqdn = fqdn;
		existing.lanIp = address || existing.lanIp;
		existing.target = target;
		await existing.save();
		return existing;
	}

	static async syncRecords(nodeId, publicIp) {
		const domain = await NodeDomain.findOne({ where: { nodeId } });
		if (!domain) {
			return null;
		}

		if (publicIp) {
			domain.publicIp = publicIp;
		}

		const address = (domain.target === 'public' ? (domain.publicIp || domain.lanIp) : domain.lanIp);
		if (!address) {
			return domain;
		}

		const recordIds = {
			apex: await CloudflareService.upsertA(domain.fqdn, address),
			wildcard: await CloudflareService.upsertA(`*.${domain.fqdn}`, address)
		};
		domain.recordIds = recordIds;
		await domain.save();
		return domain;
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
