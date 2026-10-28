import * as invoiceService from '../services/invoice.service.js';

/**
 * Invoice HTTP handlers.
 *
 * Services receive the authenticated actor (id, name, email, role) loaded by
 * `loadActor` from the database — never anything the client submitted — so
 * the identity recorded on a document is always the verified session's.
 */

function actor(req) {
    if (!req.actor) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }
    return req.actor;
}

export async function create(req, res) {
    const invoice = await invoiceService.createInvoice(actor(req), req.validated);
    return res.status(201).json({
        success: true,
        message: 'Invoice draft created successfully',
        data: { invoice },
    });
}

export async function list(req, res) {
    const result = await invoiceService.listInvoices(actor(req), req.validatedQuery);
    return res.status(200).json({
        success: true,
        data: result,
    });
}

export async function getById(req, res) {
    const invoice = await invoiceService.getInvoice(actor(req), req.validatedId);
    return res.status(200).json({
        success: true,
        data: { invoice },
    });
}

export async function timeline(req, res) {
    const result = await invoiceService.getTimeline(actor(req), req.validatedId);
    return res.status(200).json({
        success: true,
        data: result,
    });
}

export async function update(req, res) {
    const invoice = await invoiceService.updateInvoice(actor(req), req.validatedId, req.validated);
    return res.status(200).json({
        success: true,
        message: 'Invoice updated successfully',
        data: { invoice },
    });
}

export async function issue(req, res) {
    const invoice = await invoiceService.issueInvoice(actor(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice issued successfully',
        data: { invoice },
    });
}

export async function pay(req, res) {
    const invoice = await invoiceService.payInvoice(actor(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice marked as paid',
        data: { invoice },
    });
}

export async function recordPayment(req, res) {
    const { invoice, replayed } = await invoiceService.recordPayment(actor(req), req.validatedId, req.validated);
    // A replayed idempotency key did not create anything new: answer 200 so
    // the client can tell a double-click from a fresh save.
    return res.status(replayed ? 200 : 201).json({
        success: true,
        message: replayed ? 'Payment already recorded' : 'Payment recorded successfully',
        data: { invoice, replayed: Boolean(replayed) },
    });
}

export async function updatePayment(req, res) {
    const invoice = await invoiceService.updatePayment(
        actor(req),
        req.validatedId,
        req.validatedPaymentId,
        req.validated
    );
    return res.status(200).json({
        success: true,
        message: 'Payment updated successfully',
        data: { invoice },
    });
}

export async function cancel(req, res) {
    const invoice = await invoiceService.cancelInvoice(actor(req), req.validatedId);
    return res.status(200).json({
        success: true,
        message: 'Invoice cancelled successfully',
        data: { invoice },
    });
}

export async function voidInvoice(req, res) {
    const invoice = await invoiceService.voidInvoice(actor(req), req.validatedId, req.validated);
    return res.status(200).json({
        success: true,
        message: 'Invoice voided successfully',
        data: { invoice },
    });
}

export async function remove(req, res) {
    await invoiceService.deleteInvoice(actor(req), req.validatedId);
    return res.status(204).end();
}
