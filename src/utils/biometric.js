import { createPublicKey, randomBytes, verify } from 'crypto';

const CREDENTIAL_ID_MAX_LENGTH = 128;
const PUBLIC_KEY_MAX_LENGTH = 1024;
const SIGNATURE_MAX_LENGTH = 256;

function generateChallenge() {
	return randomBytes(32).toString('base64url');
}

function isValidCredentialId(credentialId) {
	return typeof credentialId === 'string' && credentialId.length > 0 && credentialId.length <= CREDENTIAL_ID_MAX_LENGTH;
}

function parsePublicKey(publicKey) {
	if (typeof publicKey !== 'string' || !publicKey || publicKey.length > PUBLIC_KEY_MAX_LENGTH) {
		return null;
	}
	try {
		const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
		if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
			return null;
		}
		return key;
	} catch (error) {
		return null;
	}
}

function verifySignature({ publicKey, challenge, signature }) {
	const key = parsePublicKey(publicKey);
	if (!key || typeof signature !== 'string' || !signature || signature.length > SIGNATURE_MAX_LENGTH) {
		return false;
	}
	try {
		return verify('sha256', Buffer.from(challenge, 'utf8'), key, Buffer.from(signature, 'base64url'));
	} catch (error) {
		return false;
	}
}

export {
	generateChallenge,
	isValidCredentialId,
	verifySignature
};
