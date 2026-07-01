import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const folderPath = path.join(__dirname, '..', '..', '..', '..', 'virgo-ui/app/dist');
const staticMiddleware = express.static(folderPath, {
	index: false,
	dotfiles: 'deny',
	etag: false
});

/**
 * Controller for serving static files and the root HTML.
 */
export {
	folderPath,
	staticMiddleware
};
