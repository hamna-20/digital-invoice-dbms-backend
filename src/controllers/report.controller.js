import * as reportService from '../services/report.service.js';
import ApiError from '../utils/ApiError.js';

function authenticatedUserId(req) {
    const userId = Number(req.user?.sub);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        throw ApiError.unauthorized('Invalid authenticated user');
    }
    return userId;
}

/** Prefers the database-verified actor loaded by `loadActor`. */
function actorId(req) {
    return req.actor?.id ?? authenticatedUserId(req);
}

export async function summary(req, res) {
    const report = await reportService.getSummary(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function dailySales(req, res) {
    const report = await reportService.getDailySales(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function monthlySales(req, res) {
    const report = await reportService.getMonthlySales(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function tax(req, res) {
    const report = await reportService.getTaxReport(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function customers(req, res) {
    const report = await reportService.getCustomerReport(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function products(req, res) {
    const report = await reportService.getProductReport(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function invoiceHistory(req, res) {
    const report = await reportService.getInvoiceHistory(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

/* ------------------------------------------------------------------ *
 * Financial status reports
 * ------------------------------------------------------------------ */

export async function returnCreditStatus(req, res) {
    const report = await reportService.getReturnsAndCreditsByStatus(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function salesTaxByRate(req, res) {
    const report = await reportService.getSalesTaxByRate(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function receivables(req, res) {
    const report = await reportService.getReceivables(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function voidedInvoices(req, res) {
    const report = await reportService.getVoidedInvoices(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function returnsReport(req, res) {
    const report = await reportService.getReturnsReport(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function customerCreditReport(req, res) {
    const report = await reportService.getCustomerCreditReport(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}

export async function activityHistory(req, res) {
    const report = await reportService.getActivityHistory(actorId(req), req.validatedQuery);
    return res.status(200).json({ success: true, data: report });
}
