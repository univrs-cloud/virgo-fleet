let socketGetter = () => {
	return null;
};

let capabilitiesGetter = () => {
	return {};
};

const registerNodeRegistry = ({ getNodeSocket, getNodeCapabilities }) => {
	if (getNodeSocket) {
		socketGetter = getNodeSocket;
	}
	if (getNodeCapabilities) {
		capabilitiesGetter = getNodeCapabilities;
	}
};

const getNodeSocket = (nodeId) => {
	return socketGetter(nodeId) ?? null;
};

const getNodeCapabilities = (nodeId) => {
	return capabilitiesGetter(nodeId) ?? {};
};

export {
	registerNodeRegistry,
	getNodeSocket,
	getNodeCapabilities
};
