import path from 'path';
import express from 'express';
import * as staticController from './static.js';

const router = express.Router();

router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'index.html'));
});

export default router;
