import http from 'http';

function createServer(app) {
	return http.createServer(app);
}

export default createServer;
