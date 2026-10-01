import { getAppUrl, getSiteUrl } from '../utils/app_url.js';

function ownOriginHandler(request, response, next) {
	const origin = String(request.get('origin') || '');
	const ownOrigins = [getSiteUrl(), getAppUrl()].filter(Boolean).map((url) => { return url.toLowerCase(); });
	if (!ownOrigins.includes(origin.toLowerCase())) {
		response.status(403).json({ status: 'failed', message: 'Not allowed.' });
		return;
	}
	response.set('Access-Control-Allow-Origin', origin);
	response.set('Vary', 'Origin');
	if (request.method.toLowerCase() === 'options') {
		response.set('Access-Control-Allow-Methods', 'POST');
		response.set('Access-Control-Allow-Headers', 'Content-Type');
		response.set('Access-Control-Max-Age', '600');
		response.status(204).end();
		return;
	}
	next();
}

export default ownOriginHandler;
