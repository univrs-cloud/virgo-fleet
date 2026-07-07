import path from 'path';
import express from 'express';
import * as staticController from './static.js';
import * as authController from './auth.js';
import * as nodeContentController from './node_content.js';

const router = express.Router();

router.post('/auth/signup', authController.signup);
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.get('/nodes/:nodeId', nodeContentController.serveNodeContent);
router.get('/nodes/:nodeId/*rest', nodeContentController.serveNodeContent);
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res, next) => {
	// Requests under /api/ are meant for Engine.IO (or a REST route above); if they reach
	// this catch-all, they didn't match anything real, so 404 instead of masking the failure
	// behind a 200 SPA shell.
	if (req.path.startsWith('/api/')) {
		next();
		return;
	}
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

export default router;
