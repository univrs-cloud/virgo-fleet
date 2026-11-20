import { createHash, createPublicKey, verify } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import { gunzip } from 'zlib';
import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';
import { fetchNodeAsset } from '../utils/node_assets.js';
import { applyFleetIdentity, renderFleetShell } from './static.js';

const RELEASE_TTL_MS = 60 * 1000;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const unpack = promisify(gunzip);
const ICON_FOLDERS = ['assets/img/apps/', 'assets/img/shortcuts/'];
const ICON_PATTERN = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const ICON_POLICY = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'";
const UNAVAILABLE_REASONS = ['unverified', 'offline', 'timeout', 'failed', 'denied', 'unavailable'];
const releases = new Map();
let releaseKey = null;

const resolveFleetUser = async (req) => {
	const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie);
	if (!sessionToken) {
		return null;
	}
	const session = await DataService.getSessionByToken(sessionToken);
	// Gated (MFA-pending) sessions can't reach proxied node content.
	if (!session || session.mfaState !== 'satisfied') {
		return null;
	}
	return session.User || null;
};

const injectNodeContext = (html, nodeId) => {
	const nodePath = `/nodes/${encodeURIComponent(nodeId)}/`;
	const failureScript = `<script>window.addEventListener('error', (event) => { if (!(event.target instanceof HTMLScriptElement) || !event.target.src) { return; } fetch(event.target.src, { cache: 'no-store' }).then((response) => { const reasons = { 502: 'unverified', 503: 'offline', 504: 'timeout' }; if (response.status >= 500) { location.replace(${JSON.stringify(`${nodePath}?reason=`)} + (reasons[response.status] || 'failed')); } }).catch(() => {}); }, true);</script>`;
	const context = `<base href="${nodePath}">${failureScript}`;
	if (/<base\s[^>]*>/i.test(html)) {
		return html.replace(/<base\s[^>]*>/i, () => { return context; });
	}
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (head) => { return `${head}${context}`; });
	}
	return `${context}${html}`;
};

const STATIC_ASSET_PATTERN = /\.(js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|txt|webmanifest)$/i;

const isAssetPath = (assetPath) => {
	const withoutQuery = (assetPath || '/').split('?')[0].split('#')[0];
	if (!withoutQuery || withoutQuery === '/') {
		return false;
	}
	return STATIC_ASSET_PATTERN.test(withoutQuery);
};

const isDocumentPath = (assetPath) => !isAssetPath(assetPath);

const isIconPath = (name) => {
	return ICON_FOLDERS.some((folder) => { return name.startsWith(folder); });
};

const sendUnavailable = (res, status, reason) => {
	const meta = `<meta name="node-unavailable" content="${(UNAVAILABLE_REASONS.includes(reason) ? reason : 'failed')}">`;
	res.status(status);
	res.set('Content-Type', 'text/html; charset=utf-8');
	res.set('Cache-Control', 'no-store');
	res.send(renderFleetShell().replace(/<head[^>]*>/i, (head) => { return `${head}${meta}`; }));
};

const reasonOf = (error) => {
	if (error.reason) {
		return error.reason;
	}
	if (error.status === 503) {
		return 'offline';
	}
	if (error.status === 504) {
		return 'timeout';
	}
	return 'failed';
};

const getReleaseKey = () => {
	if (!releaseKey) {
		const key = String(process.env.RELEASE_PUBLIC_KEY || '').trim();
		if (!key) {
			throw Object.assign(new Error('RELEASE_PUBLIC_KEY is not configured.'), { status: 503, reason: 'unavailable' });
		}
		releaseKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
	}
	return releaseKey;
};

const hashOf = (body) => {
	return createHash('sha256').update(body).digest('hex');
};

const fetchRelease = async (nodeId) => {
	const key = getReleaseKey();
	const [list, signature] = await Promise.all([
		fetchNodeAsset(nodeId, '/release.json'),
		fetchNodeAsset(nodeId, '/release.sig')
	]);
	const isSigned = (list.status === 200 && signature.status === 200 && verify(null, list.body, key, Buffer.from(signature.body.toString('utf8').trim(), 'base64')));
	if (!isSigned) {
		throw Object.assign(new Error('This node is not running a signed release.'), { status: 502, reason: 'unverified' });
	}

	const files = JSON.parse(list.body.toString('utf8'))?.files;
	if (!files || typeof files !== 'object') {
		throw Object.assign(new Error('This node sent an unreadable release.'), { status: 502, reason: 'unverified' });
	}
	return files;
};

const loadRelease = (nodeId, isFresh = false) => {
	const cached = releases.get(nodeId);
	if (!isFresh && cached && (Date.now() - cached.loadedAt) < RELEASE_TTL_MS) {
		return cached.files;
	}

	const files = fetchRelease(nodeId);
	releases.set(nodeId, { files, loadedAt: Date.now() });
	files.catch(() => {
		if (releases.get(nodeId)?.files === files) {
			releases.delete(nodeId);
		}
	});
	return files;
};

const matchesRelease = async (nodeId, name, body) => {
	const hash = hashOf(body);
	for (const isFresh of [false, true]) {
		const files = await loadRelease(nodeId, isFresh);
		if (files[name] === hash) {
			return true;
		}
	}
	return false;
};

const serveNodeContent = async (req, res, next) => {
	let isDocument = false;
	try {
		const nodeId = req.params.nodeId;
		if (!nodeId) {
			next();
			return;
		}

		const user = await resolveFleetUser(req);
		if (!user) {
			res.redirect(`/?rd=${encodeURIComponent(req.originalUrl)}`);
			return;
		}

		const restParam = req.params.rest;
		const rest = Array.isArray(restParam) ? restParam.join('/') : (restParam || '');
		const rawPath = rest ? `/${rest}` : '/';
		const name = rawPath.slice(1);
		isDocument = isDocumentPath(rawPath);

		const allowed = await DataService.canUserAccessNode(user.id, nodeId);
		if (!allowed) {
			if (isDocument) {
				sendUnavailable(res, 403, 'denied');
				return;
			}

			res.status(403).end();
			return;
		}

		if (name === 'release.json') {
			const files = await loadRelease(nodeId);
			res.set('Cache-Control', 'no-store');
			res.json({ files });
			return;
		}

		if (isDocument) {
			if (UNAVAILABLE_REASONS.includes(req.query?.reason)) {
				sendUnavailable(res, 502, req.query.reason);
				return;
			}

			const { status, body } = await fetchNodeAsset(nodeId, rawPath);
			if (status >= 400) {
				sendUnavailable(res, 502, 'failed');
				return;
			}

			if (!await matchesRelease(nodeId, 'index.html', body)) {
				sendUnavailable(res, 502, 'unverified');
				return;
			}

			res.status(status);
			res.set('Content-Type', 'text/html; charset=utf-8');
			res.set('Cache-Control', 'no-store');
			res.send(injectNodeContext(applyFleetIdentity(body.toString('utf8')), nodeId));
			return;
		}

		const isIcon = isIconPath(name);
		if (isIcon && !ICON_PATTERN.test(name)) {
			res.status(404).end();
			return;
		}

		const { status, contentEncoding, body } = await fetchNodeAsset(nodeId, rawPath, { acceptEncoding: 'gzip' });
		if (status >= 400) {
			res.status(status).end();
			return;
		}

		if (contentEncoding && contentEncoding !== 'gzip') {
			res.status(502).end();
			return;
		}

		const isPacked = (contentEncoding === 'gzip');
		if (!isIcon && !await matchesRelease(nodeId, name, (isPacked ? await unpack(body, { maxOutputLength: MAX_UNPACKED_BYTES }) : body))) {
			res.status(502).end();
			return;
		}

		res.status(status);
		res.type(path.extname(name));
		if (isPacked) {
			res.set('Content-Encoding', 'gzip');
			res.set('Vary', 'Accept-Encoding');
		}
		if (isIcon) {
			res.set('Content-Security-Policy', ICON_POLICY);
		}
		res.set('Cache-Control', 'private, max-age=3600');
		res.send(body);
	} catch (error) {
		if (error.status) {
			if (!res.headersSent) {
				if (isDocument) {
					sendUnavailable(res, error.status, reasonOf(error));
					return;
				}

				res.status(error.status).end();
				return;
			}
			if (!res.writableEnded) {
				res.destroy();
			}
			return;
		}
		next(error);
	}
};

export {
	serveNodeContent
};
