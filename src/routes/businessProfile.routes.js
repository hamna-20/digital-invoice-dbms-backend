import express from 'express';
import * as businessProfileController from '../controllers/businessProfile.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { loadActor } from '../middleware/roles.middleware.js';
import { validateBody } from '../middleware/validate.js';
import { validateUpdateBusinessProfile } from '../validators/businessProfile.validator.js';

const router = express.Router();

router.use(authenticate, loadActor);

router.get('/', businessProfileController.get);
router.put('/', validateBody(validateUpdateBusinessProfile), businessProfileController.update);

export default router;
