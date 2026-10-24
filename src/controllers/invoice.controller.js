import * as invoiceService from '../services/invoice.service.js';
import ApiError from '../utils/ApiError.js';

function authenticatedUserId(req) {
    const userId = Number(req.user?.sub);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        throw ApiError.unauthorized('Invalid authenticated user');
    }
    return userId;
}

export async function create(req, res) {
    const invoice = await invoiceService.createInvoice(authenticatedUserId(req), req.validated);
    return res.status(201).json({
        success: true,
        message: 'Invoice draft created successfully',
        data: { invoice },
    });
}

export async function list(req, res) {
    const result = await invoiceService.listInvoices(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({
        success: true,
        data: result,
    });
}

export async function getById(req, res) {
    const invoice = await invoiceService.getInvoice(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        data: { invoice },
    });
}

export async function update(req, res) {
    const invoice = await invoiceService.updateInvoice(
        authenticatedUserId(req),
        req.validatedId,
        req.validated
    );
    return res.status(200).json({
        success: true,
        message: 'Invoice draft updated successfully',
        data: { invoice },
    });
}

export async function issue(req, res) {
    const invoice = await invoiceService.issueInvoice(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice issued successfully',
        data: { invoice },
    });
}

export async function pay(req, res) {
    const invoice = await invoiceService.payInvoice(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice marked as paid',
        data: { invoice },
    });
}

export async function cancel(req, res) {
    const invoice = await invoiceService.cancelInvoice(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice cancelled successfully',
        data: { invoice },
    });
}

export async function remove(req, res) {
    await invoiceService.deleteInvoice(authenticatedUserId(req), req.validatedId);
    return res.status(204).end();
}
