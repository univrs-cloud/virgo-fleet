import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAppUrl } from '../utils/app_url.js';

const templateCache = new Map();

// Loads a template by name from src/emails/templates, the one folder every email's HTML lives
// in. Cached after first read; templates are static assets shipped in the image.
export function loadTemplate(name) {
	const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', `${name}.html`);
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

export function renderEmail(name, values) {
	return renderTemplate(loadTemplate('layout'), {
		logo: escapeHtml(`${getAppUrl()}/assets/icons/icon_96x96.png`),
		content: renderTemplate(loadTemplate(name), values)
	});
}
