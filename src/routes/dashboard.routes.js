import express from 'express';
import * as dashboardController from '../controllers/dashboard.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import ApiError from '../utils/ApiError.js';

const router = express.Router();

/**
 * The dashboard has no configurable filters: the period is always the current
 * UTC month/year. Reject unknown parameters so callers cannot assume a filter
 * was applied when it was not.
 */
function rejectUnknownQuery(req, res, next) {
    const keys = Object.keys(req.query);
    if (keys.length > 0) {
        return next(
            ApiError.badRequest('Validation failed', [
                { field: keys[0], message: 'Query parameter is not supported' },
            ])
        );
    }
    return next();
}

router.use(authenticate);
router.get('/summary', rejectUnknownQuery, dashboardController.summary);

export default router;
