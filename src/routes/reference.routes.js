import express from 'express';
import * as referenceController from '../controllers/reference.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(authenticate);

router.get('/hs-codes', referenceController.listHsCodes);
router.get('/hs-uoms', referenceController.listHsUoms);

export default router;
