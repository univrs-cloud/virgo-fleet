import { randomUUID } from 'crypto';

const ASSET_REQUEST_TIMEOUT_MS = 15000;
const pendingAssetRequests = new Map();

let getNodeSocket = () => {
	return null;
};

function registerNodeSocketGetter(getter) {
	getNodeSocket = getter;
}

function handleAssetResponse({ requestId, status, contentType, body, error } = {}) {
	const pending = pendingAssetRequests.get(requestId);
	if (!pending) {
		return;
	}
	clearTimeout(pending.timeout);
	pendingAssetRequests.delete(requestId);

	if (error || !status || status >= 400) {
		pending.reject(Object.assign(new Error(error || `Asset fetch failed (${status || 'unknown'})'), { status: status || 404 }));
		return;
	}

	pending.resolve({
		status,
		contentType: contentType || 'application/octet-stream',
		body: Buffer.from(body, 'base64')
	});
}

function attachNodeAssetHandler(nodeSocket) {
	if (nodeSocket.data?.assetHandlerAttached) {
		return;
	}
	nodeSocket.data.assetHandlerAttached = true;
	nodeSocket.on('proxy:asset:response', handleAssetResponse);
}

function fetchNodeAsset(nodeId, assetPath) {
	const nodeSocket = getNodeSocket(nodeId);
	if (!nodeSocket?.connected) {
		return Promise.reject(Object.assign(new Error('Node offline'), { status: 503 }));
	}

	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const timeout = setTimeout(() => {
			pendingAssetRequests.delete(requestId);
			reject(Object.assign(new Error('Asset request timeout'), { status: 504 }));
		}, ASSET_REQUEST_TIMEOUT_MS);

		pendingAssetRequests.set(requestId, { resolve, reject, timeout });
		nodeSocket.emit('proxy:asset', { requestId, path: assetPath });
	});
}

export {
	registerNodeSocketGetter,
	attachNodeAssetHandler,
	fetchNodeAsset
};
