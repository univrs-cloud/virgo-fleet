import path from 'path';
import express from 'express';
import * as staticController from './static.js';
import * as authController from './auth.js';
import * as messageController from './message.js';
import * as nodeContentController from './node_content.js';
import * as pushController from './push.js';
import * as webauthnController from './webauthn.js';
import * as biometricController from './biometric.js';

const router = express.Router();

const serveFleetShell = (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.send(staticController.renderFleetShell());
};

router.get('/manifest.json', (req, res) => {
	res.sendFile(path.join(staticController.folderPath, 'fleet-manifest.json'));
});
router.get('/.well-known/assetlinks.json', (req, res) => {
	res.json([{
		relation: ['delegate_permission/common.handle_all_urls'],
		target: {
			namespace: 'android_app',
			package_name: 'cloud.univrs.fleet',
			sha256_cert_fingerprints: ['02:74:0B:C4:99:EB:05:79:64:B7:6E:02:F7:71:3E:BD:F8:25:58:81:76:DA:17:DF:60:A3:B9:E8:EA:54:01:5B']
		}
	}]);
});
router.get('/.well-known/apple-app-site-association', (req, res) => {
	res.json({
		applinks: {
			details: [{
				appIDs: ['96J2Q5Y3U3.cloud.univrs.fleet'],
				components: [{ '/': '*' }]
			}]
		}
	});
});
router.post('/auth/signup', authController.signup);
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.post('/auth/password', authController.changePassword);
router.post('/auth/verify', authController.verify);
router.post('/auth/mfa/setup', authController.mfaSetup);
router.post('/auth/mfa/setup/verify', authController.mfaSetupVerify);
router.post('/auth/mfa/verify', authController.mfaVerify);
router.post('/auth/mfa/authenticator', authController.authenticatorChange);
router.post('/auth/mfa/authenticator/verify', authController.authenticatorChangeVerify);
router.post('/auth/mfa/recovery-codes', authController.regenerateRecoveryCodes);
router.post('/auth/webauthn/register/options', webauthnController.registerOptions);
router.post('/auth/webauthn/register/verify', webauthnController.registerVerify);
router.post('/auth/webauthn/options', webauthnController.authenticateOptions);
router.post('/auth/webauthn/verify', webauthnController.authenticateVerify);
router.post('/auth/webauthn/disable', webauthnController.disable);
router.post('/auth/biometric/register/options', biometricController.registerOptions);
router.post('/auth/biometric/register/verify', biometricController.registerVerify);
router.post('/auth/biometric/options', biometricController.authenticateOptions);
router.post('/auth/biometric/verify', biometricController.authenticateVerify);
router.post('/auth/biometric/disable', biometricController.disable);
router.post('/messages', messageController.send);
router.get('/push/vapid-public-key', pushController.getVapidKey);
router.post('/push/enable', pushController.enable);
router.post('/push/disable', pushController.disable);
router.get('/nodes/:nodeId', nodeContentController.serveNodeContent);
router.get('/nodes/:nodeId/*rest', nodeContentController.serveNodeContent);
// `/` already falls through to the catch-all (static has index:false); this guards a direct
// /index.html request, which express.static would otherwise serve as the raw node-identity shell.
router.get('/index.html', serveFleetShell);
router.use('/', staticController.staticMiddleware);
router.get(/.*/, (req, res, next) => {
	// Requests under /api/ are meant for Engine.IO (or a REST route above); if they reach
	// this catch-all, they didn't match anything real, so 404 instead of masking the failure
	// behind a 200 SPA shell.
	if (req.path.startsWith('/api/')) {
		next();
		return;
	}
	serveFleetShell(req, res);
});

export default router;
