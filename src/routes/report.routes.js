import express from 'express';
import * as reportController from '../controllers/report.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { loadActor } from '../middleware/roles.middleware.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCustomerReportQuery,
    validateDailySalesQuery,
    validateFinancialReportQuery,
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

router.use(authenticate, loadActor);

/* ---------------------- existing sales reports ------------------- */
router.get('/summary', validateQuery(validateSummaryQuery), reportController.summary);
router.get('/daily-sales', validateQuery(validateDailySalesQuery), reportController.dailySales);
router.get('/monthly-sales', validateQuery(validateMonthlySalesQuery), reportController.monthlySales);
router.get('/tax', validateQuery(validateTaxQuery), reportController.tax);
router.get('/customers', validateQuery(validateCustomerReportQuery), reportController.customers);
router.get('/products', validateQuery(validateProductReportQuery), reportController.products);
router.get('/invoice-history', validateQuery(validateInvoiceHistoryQuery), reportController.invoiceHistory);

/* ------------------- financial status reports -------------------- */
router.get(
    '/return-credit-status',
    validateQuery(validateFinancialReportQuery),
    reportController.returnCreditStatus
);
router.get('/sales-tax-by-rate', validateQuery(validateFinancialReportQuery), reportController.salesTaxByRate);
router.get('/receivables', validateQuery(validateFinancialReportQuery), reportController.receivables);
router.get('/voided-invoices', validateQuery(validateFinancialReportQuery), reportController.voidedInvoices);
router.get('/returns', validateQuery(validateFinancialReportQuery), reportController.returnsReport);
router.get(
    '/customer-credit',
    validateQuery(validateFinancialReportQuery),
    reportController.customerCreditReport
);
router.get('/activity', validateQuery(validateFinancialReportQuery), reportController.activityHistory);

export default router;
