import MailService from '../../services/mailer.js';
import { loadTemplate, renderTemplate, escapeHtml, getAppUrl } from '../helpers.js';

function buildVerificationUrl(token) {
	// Points at the SPA confirmation route (which calls the verify API), not the API directly.
	return `${getAppUrl()}/signup/confirm?token=${encodeURIComponent(token)}`;
}

// Builds and sends the signup email-verification message. This folder owns the "what to send" —
// its co-located template.html, the subject and the link shape — while the generic mailer
// handles delivery.
export async function sendSignupVerificationEmail({ to, displayName, token }) {
	const url = buildVerificationUrl(token);
	const html = renderTemplate(loadTemplate(import.meta.url), {
		name: escapeHtml(displayName || to),
		url: escapeHtml(url)
	});
	await MailService.sendEmail({ to, subject: 'Confirm your Univrs fleet account', html });
}
