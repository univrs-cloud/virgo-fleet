export default {
	server: {
		host: '127.0.0.1',
		port: 3000
	},
	fleet: {
		enabled: process.env.VIRGO_FLEET === 'true',
		socketPath: '/api/fleet',
		localSocketPath: '/api'
	}
};
