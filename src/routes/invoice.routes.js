import express from 'express';
import * as invoiceController from '../controllers/invoice.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCreateInvoice,
    validateInvoiceId,
    validateInvoiceListQuery,
    validateUpdateInvoice,
} from '../validators/invoice.validator.js';

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

router.use(authenticate);

router.post('/', validateBody(validateCreateInvoice), invoiceController.create);
router.get('/', validateQuery, invoiceController.list);
router.get('/:id', validateId, invoiceController.getById);
router.put('/:id', validateId, validateBody(validateUpdateInvoice), invoiceController.update);
router.patch('/:id/issue', validateId, invoiceController.issue);
router.patch('/:id/pay', validateId, invoiceController.pay);
router.patch('/:id/cancel', validateId, invoiceController.cancel);
router.delete('/:id', validateId, invoiceController.remove);

export default router;
