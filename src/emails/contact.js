import MailService from '../services/mailer.js';
import { renderEmail, escapeHtml } from './helpers.js';

export async function sendContactEmail({ to, origin, name, email, message }) {
	const html = renderEmail('contact', {
		name: escapeHtml(name),
		origin: escapeHtml(origin),
		message: escapeHtml(message).replace(/\r?\n/g, '<br>')
	});
	await MailService.sendEmail({ to, replyTo: email, subject: `Contact message from ${name}`, html });
}
