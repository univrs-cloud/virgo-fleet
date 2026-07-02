import path from 'path';
import express from 'express';
import * as staticController from './static.js';
import * as authController from './auth.js';

const router = express.Router();

router.post('/auth/signup', authController.signup);
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

export default router;
