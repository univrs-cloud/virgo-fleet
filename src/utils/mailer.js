import nodemailer from 'nodemailer';
import { convert as htmlToText } from 'html-to-text';

// SMTP is configured entirely through the container's environment (see Dockerfile / README).
// Read lazily at send time so a missing config surfaces as a send error rather than a crash at
// boot, and so tests can set the env before the first send.
function readSmtpConfig() {
	const host = process.env.SMTP_HOST;
	const port = Number(process.env.SMTP_PORT || 587);
	const user = process.env.SMTP_USER;
	const pass = process.env.SMTP_PASSWORD;
	// SMTP_SECURE=true means implicit TLS (usually port 465); otherwise STARTTLS is negotiated.
	const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
	const from = process.env.SMTP_FROM || user;
	return { host, port, user, pass, secure, from };
}

function isConfigured() {
	const { host, from } = readSmtpConfig();
	return Boolean(host && from);
}

let transporter = null;

function getTransport() {
	const { host, port, user, pass, secure } = readSmtpConfig();
	if (!host) {
		throw new Error('Email is not configured on this server.');
	}
	if (!transporter) {
		transporter = nodemailer.createTransport({
			host,
			port,
			secure,
			// Only attach credentials when both are present; some relays accept unauthenticated mail.
			auth: (user && pass) ? { user, pass } : undefined
		});
	}
	return transporter;
}

// Generic transport-only sender: it knows how to put a message on the wire, not what any
// particular email says. Callers own the subject and body; email-type specifics live under
// src/emails. When only html is given, a plain-text alternative is derived from it so every
// message ships both parts (better deliverability) without callers maintaining two bodies.
async function sendEmail({ to, subject, html, text }) {
	const { from } = readSmtpConfig();
	const textBody = text ?? (html
		? htmlToText(html, {
			wordwrap: false,
			selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: false } }]
		})
		: undefined);
	await getTransport().sendMail({ from, to, subject, html, text: textBody });
}

export {
	isConfigured,
	sendEmail
};
