import fs from 'fs';
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

// The build ships one index.html carrying the node identity; the fleet reuses it, swapping the
// role-specific bits (title, favicon, apple-touch icon, loading logo) to the fleet's. The manifest
// link is left as the absolute /manifest.json, which each origin serves as its own manifest.
const FLEET_SHELL_SUBSTITUTIONS = [
	['assets/img/virgo.svg', 'assets/img/fleet.svg'],
	['assets/icons/icon_192x192.png', 'assets/fleet-icons/icon_192x192.png']
];

let fleetShell = null;
const renderFleetShell = () => {
	if (fleetShell === null) {
		fleetShell = FLEET_SHELL_SUBSTITUTIONS.reduce(
			(html, [from, to]) => html.split(from).join(to),
			fs.readFileSync(path.join(folderPath, 'index.html'), 'utf8')
		);
	}
	return fleetShell;
};

/**
 * Controller for serving static files and the role-specific HTML shell.
 */
export {
	folderPath,
	staticMiddleware,
	renderFleetShell
};
