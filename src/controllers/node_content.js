import DataService from '../database/data_service.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';
import { fetchNodeAsset, streamNodeAsset } from '../utils/node_assets.js';
import { applyFleetIdentity } from './static.js';

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
	return session.FleetUser || null;
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

		// Documents (SPA routes) are forwarded as-is; the node's own catch-all resolves them to its
		// index.html shell, which we serve with the base rewritten. That shell's absolute /manifest.json
		// link resolves to the fleet origin, so the fleet PWA manifest applies without any rewrite here.
		if (isDocumentPath(rawPath)) {
			const { status, contentType, body } = await fetchNodeAsset(nodeId, rawPath);
			if (status >= 400) {
				res.status(status).end();
				return;
			}

			if (contentType?.startsWith('text/html')) {
				res.status(status);
				res.set('Content-Type', 'text/html; charset=utf-8');
				res.set('Cache-Control', 'no-store');
				res.send(injectNodeContext(applyFleetIdentity(body.toString('utf8')), nodeId));
				return;
			}

			res.status(status);
			if (contentType) {
				res.set('Content-Type', contentType);
			}
			res.set('Cache-Control', 'no-store');
			res.send(body);
			return;
		}

		await streamNodeAsset(nodeId, rawPath, res, {
			cacheControl: 'private, max-age=3600'
		});
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
