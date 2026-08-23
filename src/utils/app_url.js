// Where the fleet is reachable from outside, derived from DOMAIN the way Traefik routes it:
// fleet.<DOMAIN>. Several unrelated things need this same fact — email links, the issuer shown in
// authenticator apps, the WebAuthn relying party — so it lives on its own rather than next to
// whichever one happened to need it first.

// The normalised DOMAIN value, e.g. "univrs.cloud". Empty when DOMAIN is unset.
function getDomain() {
	return String(process.env.DOMAIN || '')
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}

/** The fleet's public host, e.g. "fleet.univrs.cloud". Empty string when DOMAIN is unset. */
export function getAppHost() {
	const domain = getDomain();
	return domain ? `fleet.${domain}` : '';
}

/** The fleet's public base URL, e.g. "https://fleet.univrs.cloud". Empty string when DOMAIN is
 * unset — callers decide what to do without one. */
export function getAppUrl() {
	const host = getAppHost();
	return host ? `https://${host}` : '';
}
