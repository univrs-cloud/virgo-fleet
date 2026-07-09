import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const templateCache = new Map();

// Loads the template.html that sits next to an email module — pass import.meta.url from that
// module. Cached after first read; templates are static assets shipped in the image.
export function loadTemplate(moduleUrl) {
	const file = path.join(path.dirname(fileURLToPath(moduleUrl)), 'template.html');
	if (!templateCache.has(file)) {
		templateCache.set(file, fs.readFileSync(file, 'utf8'));
	}
	return templateCache.get(file);
}

// Escape values before they land in an HTML template — anything user-supplied (a display name,
// say) must be passed through this first.
export function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Minimal {{key}} interpolation; values are expected to be pre-escaped for their context.
export function renderTemplate(template, values) {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
		return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
	});
}

// Externally reachable base URL, derived from DOMAIN the way Traefik routes the fleet:
// https://fleet.<DOMAIN>. Email links (verification, password reset, …) are built on top of it.
export function getAppUrl() {
	const domain = String(process.env.DOMAIN || '')
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
	if (domain) {
		return `https://fleet.${domain}`;
	}
	return '';
}
