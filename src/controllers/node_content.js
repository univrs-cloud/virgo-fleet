import DataService from '../database/data_service.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';
import { fetchNodeAsset } from '../utils/node_assets.js';

const resolveFleetUser = async (req) => {
	const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie);
	if (!sessionToken) {
		return null;
	}
	const session = await DataService.getSessionByToken(sessionToken);
	return session?.FleetUser || null;
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

const isDocumentPath = (assetPath) => {
	if (!assetPath || assetPath === '/' || assetPath === '') {
		return true;
	}
	const withoutQuery = assetPath.split('?')[0].split('#')[0];
	if (withoutQuery.endsWith('/')) {
		return true;
	}
	return withoutQuery.endsWith('.html');
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
		const targetPath = isDocumentPath(rawPath) ? '/index.html' : rawPath;

		const { status, contentType, body } = await fetchNodeAsset(nodeId, targetPath);
		res.status(status);

		if (isDocumentPath(rawPath) && contentType?.startsWith('text/html')) {
			res.set('Content-Type', 'text/html; charset=utf-8');
			res.set('Cache-Control', 'no-store');
			res.send(injectNodeContext(body.toString('utf8'), nodeId));
			return;
		}

		res.set('Content-Type', contentType);
		res.set('Cache-Control', 'private, max-age=3600');
		res.send(body);
	} catch (error) {
		if (error.status) {
			res.status(error.status).end();
			return;
		}
		next(error);
	}
};

export {
	serveNodeContent
};
