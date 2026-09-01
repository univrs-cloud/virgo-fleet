import express from 'express';
import helmet from 'helmet';
import authCookieHandler from './middleware/auth_cookie_handler.js';
import controllers from './controllers/index.js';
import error404Handler from './middleware/error_404_handler.js';
import errorHandler from './middleware/error_handler.js';
import frameAncestorsHandler from './middleware/frame_ancestors_handler.js';
import { authRateLimiter, webauthnOptionsRateLimiter } from './middleware/rate_limit.js';

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	// Keep helmet's baseline hardening headers, but disable its default Content-Security-Policy:
	// the UI compiles lodash templates at runtime via Function(), which CSP's script-src blocks.
	// The policy the UI does need — frame-ancestors — is written on its own below, since helmet
	// refuses a CSP that carries no default-src.
	app.use(helmet({ contentSecurityPolicy: false }));
	app.use(frameAncestorsHandler);
	app.use(express.json());
	// Throttle the credential endpoints to blunt brute-force / credential-stuffing.
	app.use(['/auth/login', '/auth/signup', '/auth/verify', '/auth/mfa/verify', '/auth/mfa/setup/verify', '/auth/webauthn/verify'], authRateLimiter);
	app.use('/auth/webauthn/options', webauthnOptionsRateLimiter);
	app.use(authCookieHandler);
	app.use(controllers);
	app.use(error404Handler);
	app.use(errorHandler);
	return app;
}

export default createApp;
