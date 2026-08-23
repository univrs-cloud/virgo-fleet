import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from '@simplewebauthn/server';
import { getAppUrl } from './app_url.js';

// Where the browser thinks it is. The relying party ID must be the origin's host (or a registrable
// suffix of it) or every ceremony fails with a SecurityError, so both are derived from the one
// place that already knows the fleet's public address. The env overrides exist for deployments that
// don't sit at fleet.<DOMAIN>; the localhost fallback keeps `npm start` usable (browsers treat
// localhost as a secure context, so WebAuthn works there without TLS).
const ORIGIN = process.env.WEBAUTHN_ORIGIN || getAppUrl() || 'http://localhost:3000';
const RP_ID = process.env.WEBAUTHN_RP_ID || new URL(ORIGIN).hostname;
const RP_NAME = 'univrs Fleet';

// Credentials are created as discoverable (resident) keys so sign-in needs no email first: the
// authenticator itself offers the account. userVerification 'required' is what makes a passkey
// stand in for password + TOTP — without it the authenticator would prove possession only, and
// skipping the other factors would be a genuine downgrade.
//
// 'platform' restricts enrollment to the device's built-in authenticator: fingerprint, face, or the
// equivalent. Without it the browser would also offer a USB security key or a phone over QR, which
// are fine credentials but are not what this feature promises. A device with no sensor therefore
// cannot enroll at all, and stays on password + TOTP.
const AUTHENTICATOR_SELECTION = {
	authenticatorAttachment: 'platform',
	residentKey: 'required',
	userVerification: 'required'
};

const encodeBuffer = (value) => {
	return Buffer.from(value).toString('base64url');
};

const decodeBuffer = (value) => {
	return new Uint8Array(Buffer.from(value, 'base64url'));
};

/** Options for navigator.credentials.create().
 *
 * Deliberately no excludeCredentials. It would stop a device enrolling twice, but a platform
 * authenticator already keys its resident credential by (rpID, user handle) and simply replaces it,
 * so re-enrolling is naturally idempotent and the list only costs us. When it does match, the
 * browser is supposed to raise InvalidStateError; Firefox reports an opaque "unknown transient"
 * error instead, which is indistinguishable from a real failure. Dropping it makes re-enrollment
 * the repair path for a device whose local marker was lost. */
async function buildRegistrationOptions({ user }) {
	return generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: RP_ID,
		// The user handle the authenticator stores alongside the credential. The row id, not the
		// email: it lands on the device and the spec asks for something non-identifying.
		userID: new Uint8Array(Buffer.from(String(user.id), 'utf8')),
		userName: user.email,
		userDisplayName: user.name || user.email,
		attestationType: 'none',
		authenticatorSelection: AUTHENTICATOR_SELECTION
	});
}

/** Verify an attestation. Returns the fields to persist, or null when the ceremony didn't check
 * out (wrong origin/RP, bad signature, or the user wasn't verified by the authenticator). */
async function verifyRegistration({ response, expectedChallenge }) {
	const result = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		requireUserVerification: true
	});
	if (!result.verified) {
		return null;
	}
	const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
	return {
		credentialId: credential.id,
		publicKey: encodeBuffer(credential.publicKey),
		counter: credential.counter,
		transports: credential.transports || [],
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp
	};
}

/** Options for navigator.credentials.get(). No allowCredentials: the account is unknown until the
 * authenticator names it, which is the whole point of a discoverable credential. */
async function buildAuthenticationOptions() {
	return generateAuthenticationOptions({
		rpID: RP_ID,
		userVerification: 'required'
	});
}

/** Verify an assertion against a stored credential. Returns the authenticator's new signature
 * counter, or null when verification fails. simplewebauthn rejects a counter that went backwards,
 * which is the cloned-authenticator signal. */
async function verifyAuthentication({ response, expectedChallenge, credential }) {
	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		requireUserVerification: true,
		credential: {
			id: credential.credentialId,
			publicKey: decodeBuffer(credential.publicKey),
			counter: Number(credential.counter),
			transports: credential.transports || undefined
		}
	});
	if (!result.verified) {
		return null;
	}
	return { counter: result.authenticationInfo.newCounter };
}

export {
	ORIGIN,
	RP_ID,
	RP_NAME,
	buildRegistrationOptions,
	verifyRegistration,
	buildAuthenticationOptions,
	verifyAuthentication
};
