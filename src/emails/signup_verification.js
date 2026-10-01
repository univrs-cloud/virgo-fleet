import MailService from '../services/mailer.js';
import { renderEmail, escapeHtml } from './helpers.js';
import { getAppUrl } from '../utils/app_url.js';

function buildVerificationUrl(token) {
	// Points at the SPA confirmation route (which calls the verify API), not the API directly.
	return `${getAppUrl()}/signup/confirm?token=${encodeURIComponent(token)}`;
}

// Builds and sends the signup email-verification message. This module owns the "what to send" —
// its template in templates/, the subject and the link shape — while the generic mailer
// handles delivery.
export async function sendSignupVerificationEmail({ to, name, token }) {
	const url = buildVerificationUrl(token);
	const html = renderEmail('signup_verification', {
		name: escapeHtml(name || to),
		url: escapeHtml(url)
	});
	await MailService.sendEmail({ to, subject: 'Confirm your Univrs fleet account', html });
}
