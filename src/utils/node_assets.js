import { randomUUID } from 'crypto';

const INITIAL_TIMEOUT_MS = 15000;
const CHUNK_TIMEOUT_MS = 30000;
const MAX_TRANSFER_MS = 300000;

const pendingHttpRequests = new Map();

let getNodeSocket = () => {
	return null;
};

function registerNodeSocketGetter(getter) {
	getNodeSocket = getter;
}

function clearPendingRequest(requestId) {
	const pending = pendingHttpRequests.get(requestId);
	if (!pending) {
		return;
	}
	if (pending.initialTimeout) {
		clearTimeout(pending.initialTimeout);
	}
	if (pending.chunkTimeout) {
		clearTimeout(pending.chunkTimeout);
	}
	if (pending.maxTimeout) {
		clearTimeout(pending.maxTimeout);
	}
	pendingHttpRequests.delete(requestId);
}

function abortNodeHttpRequest(nodeId, requestId) {
	const nodeSocket = getNodeSocket(nodeId);
	nodeSocket?.emit('proxy:http:abort', { requestId });
}

function failPendingRequest(requestId, error) {
	const pending = pendingHttpRequests.get(requestId);
	if (!pending) {
		return;
	}
	pending.aborted = true;
	const nodeId = pending.nodeId;
	clearPendingRequest(requestId);
	abortNodeHttpRequest(nodeId, requestId);
	pending.reject(error);
}

function resetChunkTimeout(requestId) {
	const pending = pendingHttpRequests.get(requestId);
	if (!pending) {
		return;
	}
	if (pending.initialTimeout) {
		clearTimeout(pending.initialTimeout);
		pending.initialTimeout = null;
	}
	if (pending.chunkTimeout) {
		clearTimeout(pending.chunkTimeout);
	}
	pending.chunkTimeout = setTimeout(() => {
		failPendingRequest(requestId, Object.assign(new Error('Asset transfer timeout'), { status: 504 }));
	}, CHUNK_TIMEOUT_MS);
}

function handleHttpResponse({ requestId, status, headers } = {}) {
	const pending = pendingHttpRequests.get(requestId);
	if (!pending || pending.aborted || pending.state !== 'awaiting_response') {
		return;
	}
	pending.state = 'streaming';
	resetChunkTimeout(requestId);
	pending.onResponse?.({ status, headers: headers || {} });
}

function toBuffer(chunk) {
	if (Buffer.isBuffer(chunk)) {
		return chunk;
	}
	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk);
	}
	if (Array.isArray(chunk)) {
		return Buffer.from(chunk);
	}
	return null;
}

function handleHttpChunk({ requestId, seq } = {}, chunk) {
	const pending = pendingHttpRequests.get(requestId);
	const data = toBuffer(chunk);
	if (!pending || pending.aborted || pending.state !== 'streaming') {
		return;
	}
	if (seq !== pending.nextExpectedSeq) {
		failPendingRequest(
			requestId,
			Object.assign(new Error(`Unexpected chunk sequence (expected ${pending.nextExpectedSeq}, got ${seq})`), { status: 502 })
		);
		return;
	}
	if (!data?.length) {
		failPendingRequest(
			requestId,
			Object.assign(new Error('Empty chunk payload'), { status: 502 })
		);
		return;
	}

	pending.nextExpectedSeq += 1;
	resetChunkTimeout(requestId);

	Promise.resolve(pending.onChunk?.(data))
		.then(() => {
			const current = pendingHttpRequests.get(requestId);
			if (!current || current.aborted || current.state !== 'streaming') {
				return;
			}
			const nodeSocket = getNodeSocket(current.nodeId);
			if (!nodeSocket?.connected) {
				failPendingRequest(requestId, Object.assign(new Error('Node offline'), { status: 503 }));
				return;
			}
			nodeSocket.emit('proxy:http:chunk:ack', { requestId, seq });
		})
		.catch((error) => {
			if (!error.status) {
				error.status = 500;
			}
			failPendingRequest(requestId, error);
		});
}

function handleHttpEnd({ requestId } = {}) {
	const pending = pendingHttpRequests.get(requestId);
	if (!pending || pending.aborted || pending.state !== 'streaming') {
		return;
	}
	pending.state = 'done';
	pending.onEnd?.();
	clearPendingRequest(requestId);
	pending.resolve();
}

function handleHttpError({ requestId, status, message } = {}) {
	failPendingRequest(
		requestId,
		Object.assign(new Error(message || 'Asset fetch failed'), { status: status || 502 })
	);
}

function attachNodeAssetHandler(nodeSocket) {
	if (nodeSocket.data?.assetHandlerAttached) {
		return;
	}
	nodeSocket.data.assetHandlerAttached = true;
	nodeSocket.on('proxy:http:response', handleHttpResponse);
	nodeSocket.on('proxy:http:chunk', handleHttpChunk);
	nodeSocket.on('proxy:http:end', handleHttpEnd);
	nodeSocket.on('proxy:http:error', handleHttpError);
}

function proxyNodeHttp(nodeId, assetPath, handlers) {
	const nodeSocket = getNodeSocket(nodeId);
	if (!nodeSocket?.connected) {
		return Promise.reject(Object.assign(new Error('Node offline'), { status: 503 }));
	}

	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		pendingHttpRequests.set(requestId, {
			nodeId,
			state: 'awaiting_response',
			nextExpectedSeq: 0,
			aborted: false,
			resolve,
			reject,
			onResponse: handlers.onResponse,
			onChunk: handlers.onChunk,
			onEnd: handlers.onEnd,
			initialTimeout: setTimeout(() => {
				failPendingRequest(requestId, Object.assign(new Error('Asset request timeout'), { status: 504 }));
			}, INITIAL_TIMEOUT_MS),
			maxTimeout: setTimeout(() => {
				failPendingRequest(requestId, Object.assign(new Error('Asset transfer timeout'), { status: 504 }));
			}, MAX_TRANSFER_MS)
		});

		nodeSocket.emit('proxy:http:request', {
			requestId,
			method: 'GET',
			path: assetPath
		});
	});
}

function writeChunkWithBackpressure(res, chunk) {
	return new Promise((resolve, reject) => {
		if (res.destroyed || res.writableEnded) {
			reject(Object.assign(new Error('Response closed'), { status: 499 }));
			return;
		}

		const ok = res.write(chunk);
		if (ok) {
			resolve();
			return;
		}

		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			res.off('drain', onDrain);
			res.off('error', onError);
		};

		res.once('drain', onDrain);
		res.once('error', onError);
	});
}

async function fetchNodeAsset(nodeId, assetPath) {
	const chunks = [];
	const result = {
		status: 502,
		contentType: 'application/octet-stream',
		body: Buffer.alloc(0)
	};

	await proxyNodeHttp(nodeId, assetPath, {
		onResponse: ({ status, headers }) => {
			result.status = status;
			result.contentType = headers['content-type'] || result.contentType;
		},
		onChunk: (chunk) => {
			chunks.push(chunk);
		},
		onEnd: () => {
			result.body = Buffer.concat(chunks);
		}
	});

	return result;
}

async function streamNodeAsset(nodeId, assetPath, res, { cacheControl } = {}) {
	await proxyNodeHttp(nodeId, assetPath, {
		onResponse: ({ status, headers }) => {
			res.status(status);
			if (headers['content-type']) {
				res.set('Content-Type', headers['content-type']);
			}
			if (cacheControl) {
				res.set('Cache-Control', cacheControl);
			}
		},
		onChunk: (chunk) => writeChunkWithBackpressure(res, chunk),
		onEnd: () => {
			if (!res.writableEnded) {
				res.end();
			}
		}
	});
}

export {
	registerNodeSocketGetter,
	attachNodeAssetHandler,
	fetchNodeAsset,
	streamNodeAsset
};
