import express from 'express';
import * as invoiceController from '../controllers/invoice.controller.js';
import * as financialController from '../controllers/financial.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { loadActor, requirePermission } from '../middleware/roles.middleware.js';
import { validateBody } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCreateInvoice,
    validateInvoiceId,
    validateInvoiceListQuery,
    validateInvoicePayment,
    validateUpdateInvoice,
    validateVoidInvoice,
} from '../validators/invoice.validator.js';
import {
    validateCancelReturn,
    validateCreateReturn,
    validateReturnRejection,
} from '../validators/financial.validator.js';

const router = express.Router();

function validateQuery(req, res, next) {
    const { errors, value } = validateInvoiceListQuery(req.query);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedQuery = value;
    return next();
}

function validateId(req, res, next) {
    const { errors, value } = validateInvoiceId(req.params.id);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedId = value;
    return next();
}

/** Validates the id of a return, which is the only related document left. */
function validateReturnId(req, res, next) {
    const { errors, value } = validateInvoiceId(req.params.returnId);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedRelatedId = value;
    return next();
}

function validatePaymentId(req, res, next) {
    const { errors, value } = validateInvoiceId(req.params.paymentId);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedPaymentId = value;
    return next();
}

router.use(authenticate, loadActor);

/* ---------------------------- drafts ---------------------------- */
router.post('/', requirePermission('invoice.create'), validateBody(validateCreateInvoice), invoiceController.create);
router.get('/', requirePermission('invoice.read'), validateQuery, invoiceController.list);

/* ------------------------- returns ------------------------------ */
router.post(
    '/:id/returns',
    validateId,
    requirePermission('return.create'),
    validateBody(validateCreateReturn),
    financialController.createReturn
);
router.get(
    '/:id/returns/:returnId',
    validateId,
    validateReturnId,
    requirePermission('invoice.read'),
    financialController.getReturn
);
router.patch(
    '/:id/returns/:returnId',
    validateId,
    validateReturnId,
    requirePermission('return.create'),
    validateBody(validateCreateReturn),
    financialController.updateReturn
);
router.patch(
    '/:id/returns/:returnId/approve',
    validateId,
    validateReturnId,
    requirePermission('return.approve'),
    financialController.approveReturn
);
router.patch(
    '/:id/returns/:returnId/reject',
    validateId,
    validateReturnId,
    requirePermission('return.approve'),
    validateBody(validateReturnRejection),
    financialController.rejectReturn
);
router.patch(
    '/:id/returns/:returnId/cancel',
    validateId,
    validateReturnId,
    requirePermission('return.cancel'),
    validateBody(validateCancelReturn),
    financialController.cancelReturn
);

/* --------------------------- invoice ---------------------------- */
router.get('/:id', validateId, invoiceController.getById);
router.get('/:id/timeline', validateId, invoiceController.timeline);
router.put(
    '/:id',
    validateId,
    requirePermission('invoice.edit_draft'),
    validateBody(validateUpdateInvoice),
    invoiceController.update
);
router.patch('/:id/issue', validateId, requirePermission('invoice.issue'), invoiceController.issue);
router.patch('/:id/pay', validateId, requirePermission('payment.create'), invoiceController.pay);
router.post(
    '/:id/payments',
    validateId,
    requirePermission('payment.create'),
    validateBody(validateInvoicePayment),
    invoiceController.recordPayment
);
router.patch(
    '/:id/payments/:paymentId',
    validateId,
    validatePaymentId,
    requirePermission('payment.create'),
    validateBody(validateInvoicePayment),
    invoiceController.updatePayment
);
router.patch('/:id/cancel', validateId, requirePermission('invoice.cancel'), invoiceController.cancel);
router.patch(
    '/:id/void',
    validateId,
    requirePermission('invoice.void'),
    validateBody(validateVoidInvoice),
    invoiceController.voidInvoice
);
router.delete('/:id', validateId, requirePermission('invoice.edit_draft'), invoiceController.remove);

export default router;