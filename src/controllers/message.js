import MailService from '../services/mailer.js';
import { sendContactEmail } from '../emails/contact.js';
import { normalizeEmail } from '../utils/email.js';

const NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;
const MESSAGE_MAX_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOPICS = {
	contact: { recipient: () => { return process.env.CONTACT_EMAIL; }, sendEmail: sendContactEmail }
};

function getTopic(value) {
	const key = String(value || '').trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(TOPICS, key) ? TOPICS[key] : null;
}

async function send(req, res) {
	const topic = getTopic(req.body?.topic);
	const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim();
	const email = normalizeEmail(req.body?.email);
	const message = String(req.body?.message || '').trim();
	if (String(req.body?.website || '').trim()) {
		res.json({ status: 'succeeded' });
		return;
	}
	if (!topic) {
		res.status(400).json({ status: 'failed', field: 'topic', message: 'Unknown topic.' });
		return;
	}
	if (!name || name.length > NAME_MAX_LENGTH) {
		res.status(400).json({ status: 'failed', field: 'name', message: 'Enter your name.' });
		return;
	}
	if (!EMAIL_PATTERN.test(email) || email.length > EMAIL_MAX_LENGTH) {
		res.status(400).json({ status: 'failed', field: 'email', message: 'Enter a valid email address.' });
		return;
	}
	if (!message || message.length > MESSAGE_MAX_LENGTH) {
		res.status(400).json({ status: 'failed', field: 'message', message: `Enter a message of at most ${MESSAGE_MAX_LENGTH} characters.` });
		return;
	}
	const to = normalizeEmail(topic.recipient());
	if (!to || !MailService.isConfigured()) {
		res.status(503).json({ status: 'failed', message: 'Messages cannot be sent right now.' });
		return;
	}
	try {
		await topic.sendEmail({ to, origin: req.get('origin'), name, email, message });
		res.json({ status: 'succeeded' });
	} catch (error) {
		console.error(error);
		res.status(502).json({ status: 'failed', message: 'The message could not be sent.' });
	}
}

export {
	send
};
