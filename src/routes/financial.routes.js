import express from 'express';
import * as financialController from '../controllers/financial.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { loadActor, requirePermission } from '../middleware/roles.middleware.js';
import { validateBody } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCancelReturn,
    validateCreditEntryReversal,
    validateCustomerCreditApplication,
    validateFinancialListQuery,
    validateGrantCredit,
    validateRegisterQuery,
    validateReturnRejection,
} from '../validators/financial.validator.js';

const router = express.Router();

function validateQuery(validator) {
    return (req, res, next) => {
        const { errors, value } = validator(req.query);
        if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
        req.validatedQuery = value;
        return next();
    };
}

/** Validates a customer id from the URL. */
function validateCustomerId(req, res, next) {
    const value = Number(req.params.customerId);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        return next(ApiError.badRequest('Validation failed', [{ field: 'customerId', message: 'Must be a valid record ID' }]));
    }
    req.validatedId = value;
    return next();
}

/** Validates a return id or a credit entry id from the URL. */
function validateRelatedId(req, res, next) {
    const raw = req.params.returnId ?? req.params.entryId;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        return next(ApiError.badRequest('Validation failed', [{ field: 'id', message: 'Must be a valid record ID' }]));
    }
    req.validatedRelatedId = value;
    return next();
}

// Scoped to the paths this router owns, so unknown /api paths still reach the 404 handler.
const OWNED_PATHS = ['/documents', '/returns', '/customers', '/credit-entries'];

router.use(OWNED_PATHS, authenticate, loadActor);

/* ---------------------- document register ----------------------- */
router.get('/documents', validateQuery(validateRegisterQuery), financialController.documentRegister);

/* ---------------------------- returns --------------------------- */
router.get('/returns', validateQuery(validateFinancialListQuery), financialController.listReturns);
router.get('/returns/:returnId', validateRelatedId, financialController.getReturn);
router.patch(
    '/returns/:returnId/approve',
    validateRelatedId,
    requirePermission('return.approve'),
    financialController.approveReturn
);
router.patch(
    '/returns/:returnId/reject',
    validateRelatedId,
    requirePermission('return.approve'),
    validateBody(validateReturnRejection),
    financialController.rejectReturn
);
router.patch(
    '/returns/:returnId/cancel',
    validateRelatedId,
    requirePermission('return.cancel'),
    validateBody(validateCancelReturn),
    financialController.cancelReturn
);

/* ----------------------- customer credit ------------------------ */
router.get('/customers/:customerId/credit', validateCustomerId, financialController.getCustomerCredit);
router.post(
    '/customers/:customerId/credit',
    validateCustomerId,
    requirePermission('credit.grant'),
    validateBody(validateGrantCredit),
    financialController.grantCustomerCredit
);
router.post(
    '/customers/:customerId/credit/applications',
    validateCustomerId,
    requirePermission('credit.apply'),
    validateBody(validateCustomerCreditApplication),
    financialController.applyCustomerCredit
);
router.post(
    '/credit-entries/:entryId/reverse',
    validateRelatedId,
    requirePermission('credit.reverse'),
    validateBody(validateCreditEntryReversal),
    financialController.reverseCreditEntry
);

export default router;