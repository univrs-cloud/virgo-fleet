import { createHash, createPublicKey, verify } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import { gunzip } from 'zlib';
import DataService from '../services/data_service.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';
import { fetchNodeAsset } from '../utils/node_assets.js';
import { applyFleetIdentity } from './static.js';

const RELEASE_TTL_MS = 60 * 1000;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const unpack = promisify(gunzip);
const ICON_FOLDERS = ['assets/img/apps/', 'assets/img/shortcuts/'];
const ICON_PATTERN = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const ICON_POLICY = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'";
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
	const baseTag = `<base href="/nodes/${nodeId}/">`;
	if (/<base\s[^>]*>/i.test(html)) {
		return html.replace(/<base\s[^>]*>/i, baseTag);
	}
	if (html.includes('</head>')) {
		return html.replace('</head>', `${baseTag}</head>`);
	}
	return `${baseTag}${html}`;
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

const getReleaseKey = () => {
	if (!releaseKey) {
		const key = String(process.env.RELEASE_PUBLIC_KEY || '').trim();
		if (!key) {
			throw Object.assign(new Error('RELEASE_PUBLIC_KEY is not configured.'), { status: 503 });
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
		throw Object.assign(new Error('This node is not running a signed release.'), { status: 502 });
	}

	const files = JSON.parse(list.body.toString('utf8'))?.files;
	if (!files || typeof files !== 'object') {
		throw Object.assign(new Error('This node sent an unreadable release.'), { status: 502 });
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

		const allowed = await DataService.canUserAccessNode(user.id, nodeId);
		if (!allowed) {
			res.status(403).end();
			return;
		}

		const restParam = req.params.rest;
		const rest = Array.isArray(restParam) ? restParam.join('/') : (restParam || '');
		const rawPath = rest ? `/${rest}` : '/';
		const name = rawPath.slice(1);

		if (name === 'release.json') {
			const files = await loadRelease(nodeId);
			res.set('Cache-Control', 'no-store');
			res.json({ files });
			return;
		}

		if (isDocumentPath(rawPath)) {
			const { status, body } = await fetchNodeAsset(nodeId, rawPath);
			if (status >= 400) {
				res.status(status).end();
				return;
			}

			if (!await matchesRelease(nodeId, 'index.html', body)) {
				res.status(502).end();
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
