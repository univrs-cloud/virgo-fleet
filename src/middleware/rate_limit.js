import rateLimit from 'express-rate-limit';

// Limits repeated auth attempts per client IP to slow brute-force / credential-stuffing.
// `trust proxy` is enabled on the app, so the limiter keys off the real client IP.
export const authRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 20,
	standardHeaders: true,
	legacyHeaders: false,
	// The app runs behind a trusted reverse proxy (`trust proxy` is on), so the client IP comes
	// from X-Forwarded-For; silence the limiter's permissive-trust-proxy validation.
	validate: { trustProxy: false },
	message: { status: 'failed', message: 'Too many attempts, please try again later.' }
});

// Starting a passkey ceremony only hands out a random challenge — it proves nothing and reveals
// nothing about whether an account exists. The sign-in screen fires it automatically on every
// launch, so the strict credential limiter would lock out a whole office behind one NAT address;
// this cap is loose enough for that and still bounds challenge-row churn.
export const webauthnOptionsRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 120,
	standardHeaders: true,
	legacyHeaders: false,
	validate: { trustProxy: false },
	message: { status: 'failed', message: 'Too many attempts, please try again later.' }
});
