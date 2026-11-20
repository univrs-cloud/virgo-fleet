import { X509Certificate, createPublicKey, randomBytes, verify } from 'crypto';
import { AsnParser } from '@peculiar/asn1-schema';
import { AttestationApplicationId, NonStandardKeyDescription, SecurityLevel, id_ce_keyDescription } from '@peculiar/asn1-android';
import { Certificate } from '@peculiar/asn1-x509';

const CREDENTIAL_ID_MAX_LENGTH = 128;
const PUBLIC_KEY_MAX_LENGTH = 1024;
const SIGNATURE_MAX_LENGTH = 256;
const CERTIFICATE_MAX_LENGTH = 8192;
const CHAIN_MAX_LENGTH = 8;
const PACKAGE_NAME = 'cloud.univrs.fleet';
const SIGNING_CERTIFICATE_DIGEST = '02740bc499eb057964b76e02f7713ebdf825588176da17df60a3b9e8ea54015b';
const FINGERPRINT_AUTHENTICATOR = 2;
const REVOCATION_URL = 'https://android.googleapis.com/attestation/status';
const REVOCATION_TTL_MS = 1000 * 60 * 60;
const GOOGLE_ROOTS = [
	`-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----`,
	`-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----`
];

let trustedRootKeys = null;
let revocations = null;

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

function spkiOf(key) {
	return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

function isTrustedRoot(root) {
	if (!trustedRootKeys) {
		trustedRootKeys = new Set(GOOGLE_ROOTS.map((pem) => { return spkiOf(new X509Certificate(pem).publicKey); }));
	}
	return trustedRootKeys.has(spkiOf(root.publicKey));
}

async function loadRevocations() {
	if (revocations && (Date.now() - revocations.loadedAt) < REVOCATION_TTL_MS) {
		return revocations.entries;
	}
	const response = await fetch(REVOCATION_URL, { signal: AbortSignal.timeout(10000) });
	if (!response.ok) {
		throw new Error(`Revocation list answered ${response.status}`);
	}
	const entries = (await response.json())?.entries || {};
	revocations = { entries, loadedAt: Date.now() };
	return entries;
}

function serialOf(certificate) {
	return certificate.serialNumber.toLowerCase().replace(/^0+/, '');
}

function keyDescriptionOf(der) {
	const extension = AsnParser.parse(der, Certificate).tbsCertificate.extensions?.find((entry) => { return entry.extnID === id_ce_keyDescription; });
	return (extension ? AsnParser.parse(extension.extnValue.buffer, NonStandardKeyDescription) : null);
}

function appOf(description) {
	const applicationId = (description.softwareEnforced.findProperty('attestationApplicationId') || description.teeEnforced.findProperty('attestationApplicationId'));
	if (!applicationId) {
		return { packages: [], digests: [] };
	}
	const parsed = AsnParser.parse(applicationId.buffer, AttestationApplicationId);
	return {
		packages: parsed.packageInfos.map((info) => { return Buffer.from(info.packageName.buffer).toString('utf8'); }),
		digests: parsed.signatureDigests.map((digest) => { return Buffer.from(digest.buffer).toString('hex'); })
	};
}

function refuse(reason) {
	console.warn(`Biometric enrollment refused: ${reason}`);
	return false;
}

async function verifyAttestation({ certificates, publicKey, challenge }) {
	if (!Array.isArray(certificates) || certificates.length < 2 || certificates.length > CHAIN_MAX_LENGTH || !certificates.every((entry) => { return typeof entry === 'string' && entry.length > 0 && entry.length <= CERTIFICATE_MAX_LENGTH; })) {
		return refuse(`no usable certificate chain was sent (${Array.isArray(certificates) ? `${certificates.length} certificates` : typeof certificates}).`);
	}
	try {
		const ders = certificates.map((entry) => { return Buffer.from(entry, 'base64url'); });
		const chain = ders.map((der) => { return new X509Certificate(der); });
		const root = chain[chain.length - 1];
		if (!chain.every((certificate, index) => { return certificate.verify((chain[index + 1] || root).publicKey); })) {
			return refuse('the certificate chain is not signed in order.');
		}
		if (!isTrustedRoot(root)) {
			return refuse(`the chain ends at an unknown root (${root.subject.replace(/\n/g, ', ')}).`);
		}

		const entries = await loadRevocations();
		const revoked = chain.find((certificate) => { return Boolean(entries[serialOf(certificate)]); });
		if (revoked) {
			return refuse(`certificate ${serialOf(revoked)} is ${entries[serialOf(revoked)].status}.`);
		}

		if (ders.slice(1).some((der) => { return keyDescriptionOf(der); })) {
			return refuse('a certificate above the key carries its own attestation.');
		}

		const leafKey = parsePublicKey(publicKey);
		const description = keyDescriptionOf(ders[0]);
		if (!leafKey || !description) {
			return refuse((leafKey ? 'the key certificate has no attestation.' : 'the public key is not a P-256 key.'));
		}
		if (spkiOf(chain[0].publicKey) !== spkiOf(leafKey)) {
			return refuse('the attested key is not the key that signed the challenge.');
		}
		if (![SecurityLevel.trustedEnvironment, SecurityLevel.strongBox].includes(description.attestationSecurityLevel)) {
			return refuse(`the key is not in secure hardware (security level ${description.attestationSecurityLevel}).`);
		}
		if (!Buffer.from(description.attestationChallenge.buffer).equals(Buffer.from(challenge, 'utf8'))) {
			return refuse('the attested challenge does not match.');
		}

		const hardware = description.teeEnforced;
		const userAuthType = hardware.findProperty('userAuthType');
		if (hardware.findProperty('noAuthRequired') !== undefined || (Number(userAuthType) & FINGERPRINT_AUTHENTICATOR) === 0) {
			return refuse(`the key does not require a fingerprint (userAuthType ${userAuthType}).`);
		}

		const app = appOf(description);
		if (!app.packages.includes(PACKAGE_NAME) || !app.digests.includes(SIGNING_CERTIFICATE_DIGEST)) {
			return refuse(`the key belongs to another app (${app.packages.join(', ') || 'none'}, signed ${app.digests.join(', ') || 'none'}).`);
		}
		return true;
	} catch (error) {
		console.error('Could not verify a biometric attestation:', error);
		return false;
	}
}

export {
	generateChallenge,
	isValidCredentialId,
	verifyAttestation,
	verifySignature
};
