import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import { getRequestClientContext, getSocketClientContext } from '../utils/client_context.js';

const AUTH_ATTEMPT_LIMIT = 20;
export const AUTH_RATE_LIMIT_MESSAGE = 'Too many attempts, please try again later.';
const authAttemptStore = new MemoryStore();

// The address a limiter keys on: the same rule the sockets and the session records use, so a client
// the proxy did not vouch for cannot forge a header and land itself in a fresh bucket every attempt.
const clientKey = (request) => {
	return ipKeyGenerator(getRequestClientContext(request).ipAddress || 'unknown');
};

// Limits repeated auth attempts per client IP to slow brute-force / credential-stuffing.
export const authRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: AUTH_ATTEMPT_LIMIT,
	store: authAttemptStore,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: clientKey,
	message: { status: 'failed', message: AUTH_RATE_LIMIT_MESSAGE }
});

export const consumeSocketAuthAttempt = async (socket) => {
	const key = ipKeyGenerator(getSocketClientContext(socket).ipAddress || 'unknown');
	const { totalHits } = await authAttemptStore.increment(key);
	return totalHits <= AUTH_ATTEMPT_LIMIT;
};

// Starting a passkey ceremony only hands out a random challenge — it proves nothing and reveals
// nothing about whether an account exists. The sign-in screen fires it automatically on every
// launch, so the strict credential limiter would lock out a whole office behind one NAT address;
// this cap is loose enough for that and still bounds challenge-row churn.
export const webauthnOptionsRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 120,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: clientKey,
	message: { status: 'failed', message: AUTH_RATE_LIMIT_MESSAGE }
});
