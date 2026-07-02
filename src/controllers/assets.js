import DataService from '../database/data_service.js';
import { getSessionTokenFromCookieHeader } from '../utils/auth_cookies.js';
import { fetchNodeAsset } from '../utils/node_assets.js';

async function resolveFleetUser(req) {
	const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie);
	if (!sessionToken) {
		return null;
	}
	const session = await DataService.getSessionByToken(sessionToken);
	return session?.FleetUser || null;
}

async function serveNodeAsset(req, res, next) {
	try {
		const { nodeId, type, file } = req.params;
		if (!file || file.includes('/') || file.includes('..')) {
			res.status(400).end();
			return;
		}

		const user = await resolveFleetUser(req);
		if (!user) {
			res.status(401).end();
			return;
		}

		const allowed = await DataService.canUserAccessNode(user.id, nodeId);
		if (!allowed) {
			res.status(403).end();
			return;
		}

		const assetPath = `/assets/img/${type}/${file}`;
		const { status, contentType, body } = await fetchNodeAsset(nodeId, assetPath);
		res.status(status);
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
}

export {
	serveNodeAsset
};
