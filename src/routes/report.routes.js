import express from 'express';
import * as reportController from '../controllers/report.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCustomerReportQuery,
    validateDailySalesQuery,
    validateInvoiceHistoryQuery,
    validateMonthlySalesQuery,
    validateProductReportQuery,
    validateSummaryQuery,
    validateTaxQuery,
} from '../validators/report.validator.js';

const router = express.Router();

/**
 * Wraps a report query validator so every endpoint uses the same error shape
 * as the invoice endpoints: 400 + field-level details.
 */
function validateQuery(validator) {
    return (req, res, next) => {
        const { errors, value } = validator(req.query);
        if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
        req.validatedQuery = value;
        return next();
    };
}

router.use(authenticate);

router.get('/summary', validateQuery(validateSummaryQuery), reportController.summary);
router.get('/daily-sales', validateQuery(validateDailySalesQuery), reportController.dailySales);
router.get('/monthly-sales', validateQuery(validateMonthlySalesQuery), reportController.monthlySales);
router.get('/tax', validateQuery(validateTaxQuery), reportController.tax);
router.get('/customers', validateQuery(validateCustomerReportQuery), reportController.customers);
router.get('/products', validateQuery(validateProductReportQuery), reportController.products);
router.get('/invoice-history', validateQuery(validateInvoiceHistoryQuery), reportController.invoiceHistory);

export default router;
