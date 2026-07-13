import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSecret as otpGenerateSecret, generateURI, verifySync } from 'otplib';

// otplib v13 verifies with a per-call tolerance in seconds; 30s ≈ one time step of drift each way.
const CLOCK_TOLERANCE_SECONDS = 30;
// Issuer shown in the authenticator app — the fleet host (fleet.<DOMAIN>, e.g. fleet.univrs.cloud),
// matching how Traefik routes the fleet and how getAppUrl builds email links.
const ISSUER = (() => {
	const domain = String(process.env.DOMAIN || '')
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
	return domain ? `fleet.${domain}` : 'Univrs Fleet';
})();
const RECOVERY_CODE_COUNT = 10;

// TOTP secrets must be stored in a reversible form (unlike passwords) so we can verify codes. When
// MFA_SECRET_KEY is set they are AES-256-GCM encrypted at rest; without it they are stored as-is
// (works, but a Postgres dump would expose them) — we warn once so this isn't silent.
let warnedAboutMissingKey = false;
const encryptionKey = () => {
	const raw = process.env.MFA_SECRET_KEY;
	if (!raw) {
		if (!warnedAboutMissingKey) {
			console.warn('[totp] MFA_SECRET_KEY is not set — TOTP secrets are stored unencrypted. Set it to enable at-rest encryption.');
			warnedAboutMissingKey = true;
		}
		return null;
	}
	// Derive a fixed 32-byte key from whatever string is provided.
	return createHash('sha256').update(raw).digest();
};

const encryptSecret = (plaintext) => {
	const key = encryptionKey();
	if (!key) {
		return `plain:${plaintext}`;
	}
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `gcm:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
};

const decryptSecret = (stored) => {
	if (!stored) {
		return null;
	}
	if (stored.startsWith('plain:')) {
		return stored.slice('plain:'.length);
	}
	if (!stored.startsWith('gcm:')) {
		return stored; // legacy/raw
	}
	const key = encryptionKey();
	if (!key) {
		throw new Error('MFA_SECRET_KEY is required to read an encrypted TOTP secret.');
	}
	const [, ivB64, tagB64, dataB64] = stored.split(':');
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
};

const generateSecret = () => {
	return otpGenerateSecret();
};

/** otpauth:// URI the authenticator app consumes (rendered as a QR by the client). */
const buildOtpauthUrl = (email, secret) => {
	return generateURI({ issuer: ISSUER, label: email, secret });
};

const verifyToken = (token, secret) => {
	if (!token || !secret) {
		return false;
	}
	try {
		// v13 returns a result object, not a boolean.
		const result = verifySync({
			token: String(token).replace(/\s/g, ''),
			secret,
			epochTolerance: CLOCK_TOLERANCE_SECONDS
		});
		return result?.valid === true;
	} catch {
		return false;
	}
};

const generateRecoveryCodes = () => {
	return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
		const raw = randomBytes(5).toString('hex'); // 10 hex chars
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
};

const hashRecoveryCode = (code) => {
	return bcrypt.hashSync(code.replace(/\s/g, '').toLowerCase(), 10);
};

const verifyRecoveryCode = (code, hash) => {
	return bcrypt.compareSync(String(code).replace(/\s/g, '').toLowerCase(), hash);
};

export {
	encryptSecret,
	decryptSecret,
	generateSecret,
	buildOtpauthUrl,
	verifyToken,
	generateRecoveryCodes,
	hashRecoveryCode,
	verifyRecoveryCode
};
