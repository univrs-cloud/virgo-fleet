import express from 'express';
import helmet from 'helmet';
import authCookieHandler from './middleware/auth_cookie_handler.js';
import controllers from './controllers/index.js';
import error404Handler from './middleware/error_404_handler.js';
import errorHandler from './middleware/error_handler.js';
import { authRateLimiter } from './middleware/rate_limit.js';

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(helmet());
	app.use(express.json());
	// Throttle the credential endpoints to blunt brute-force / credential-stuffing.
	app.use(['/auth/login', '/auth/signup'], authRateLimiter);
	app.use(authCookieHandler);
	app.use(controllers);
	app.use(error404Handler);
	app.use(errorHandler);
	return app;
}

export default createApp;
