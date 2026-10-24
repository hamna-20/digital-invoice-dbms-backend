import express from 'express';
import rateLimit from 'express-rate-limit';
import config from '../config/index.js';
import * as authController from '../controllers/auth.controller.js';
import { validateBody } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validateSignup, validateSignin } from '../validators/auth.validator.js';

const router = express.Router();

/**
 * Brute-force protection for credential endpoints.
 * Applied per-route (not globally) so a noisy client cannot exhaust the budget
 * for unrelated endpoints.
 */
const authRateLimiter = rateLimit({
    windowMs: config.security.authRateLimit.windowMs,
    limit: config.security.authRateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many authentication attempts. Please try again later.',
    },
});

router.post('/signup', authRateLimiter, validateBody(validateSignup), authController.signup);
router.post('/signin', authRateLimiter, validateBody(validateSignin), authController.signin);
router.get('/me', authenticate, authController.me);

export default router;
