const API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15000;

class CloudflareService {
	static getZone() {
		return String(process.env.CLOUDFLARE_ZONE || '').trim().toLowerCase();
	}

	static getZoneId() {
		return String(process.env.CLOUDFLARE_ZONE_ID || '').trim();
	}

	static isManagedZone(domain) {
		return String(domain || '').trim().toLowerCase() === this.getZone();
	}

	static findRecords({ type, name }) {
		const query = new URLSearchParams({ ...(type ? { type } : {}), name, per_page: '100' });
		return this.#request('GET', `/dns_records?${query}`);
	}

	static async createTxt(name, value) {
		const record = await this.#request('POST', '/dns_records', { type: 'TXT', name, content: value, ttl: 60 });
		return record.id;
	}

	static async upsertA(name, address) {
		const [existing] = await this.findRecords({ type: 'A', name });
		const body = { type: 'A', name, content: address, ttl: 300, proxied: false };
		const record = existing
			? await this.#request('PATCH', `/dns_records/${existing.id}`, body)
			: await this.#request('POST', '/dns_records', body);
		return record.id;
	}

	static async upsertCname(name, target) {
		const [existing] = await this.findRecords({ type: 'CNAME', name });
		const body = { type: 'CNAME', name, content: target, ttl: 300, proxied: false };
		const record = existing
			? await this.#request('PATCH', `/dns_records/${existing.id}`, body)
			: await this.#request('POST', '/dns_records', body);
		return record.id;
	}

	static async deleteRecord(id) {
		if (!id) {
			return;
		}

		try {
			await this.#request('DELETE', `/dns_records/${id}`);
		} catch (error) {
			console.warn(`[cloudflare] could not delete record ${id}: ${error.message}`);
		}
	}

	static async deleteRecords(ids) {
		for (const id of ids) {
			await this.deleteRecord(id);
		}
	}

	static async #request(method, path, body) {
		const response = await fetch(`${API_BASE}/zones/${this.getZoneId()}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
				'content-type': 'application/json'
			},
			body: (body ? JSON.stringify(body) : undefined),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});

		const payload = await response.json().catch(() => { return null; });
		if (!response.ok || !payload?.success) {
			const reason = payload?.errors?.map((error) => { return error.message; }).join(', ');
			throw new Error(`Cloudflare ${method} ${path} failed: ${reason || response.status}`);
		}

		return payload.result;
	}
}

export default CloudflareService;
