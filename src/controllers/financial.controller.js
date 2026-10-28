import * as financialService from '../services/financial.service.js';
import * as creditService from '../services/credit.service.js';

/**
 * Financial HTTP handlers: returns, return-credit settlement, the document
 * register and customer credit.
 *
 * Every handler passes the authenticated actor straight through; the services
 * re-check the same permission map before touching any money.
 */

function actor(req) {
    if (!req.actor) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }
    return req.actor;
}

/* ---------------------------- returns ---------------------------- */

export async function createReturn(req, res) {
    const record = await financialService.createReturn(actor(req), req.validatedId, req.validated);
    return res.status(201).json({ success: true, message: 'Return created', data: { return: record } });
}

export async function updateReturn(req, res) {
    const record = await financialService.updateReturn(
        actor(req),
        req.validatedId,
        req.validatedRelatedId,
        req.validated
    );
    return res.status(200).json({ success: true, message: 'Return updated', data: { return: record } });
}

export async function getReturn(req, res) {
    const record = await financialService.getReturn(actor(req), req.validatedRelatedId);
    return res.status(200).json({ success: true, data: { return: record } });
}

export async function listReturns(req, res) {
    const result = await financialService.listReturns(actor(req).id, req.validatedQuery);
    return res.status(200).json({ success: true, data: result });
}

export async function approveReturn(req, res) {
    // data.return keeps its historical shape; data.invoice is the
    // recalculated invoice summary (totals, statuses, account summary) so the
    // modal and the list row refresh without a page reload.
    const result = await financialService.approveReturn(actor(req), req.validatedRelatedId);
    return res.status(200).json({ success: true, message: 'Return approved', data: result });
}

export async function rejectReturn(req, res) {
    const record = await financialService.cancelReturn(
        actor(req),
        req.validatedRelatedId,
        req.validated.reason,
        'rejected'
    );
    return res.status(200).json({ success: true, message: 'Return rejected', data: { return: record } });
}

export async function cancelReturn(req, res) {
    const record = await financialService.cancelReturn(
        actor(req),
        req.validatedRelatedId,
        req.validated.reason,
        'cancelled'
    );
    return res.status(200).json({ success: true, message: 'Return cancelled', data: { return: record } });
}



/* --------------------------- register ---------------------------- */

export async function documentRegister(req, res) {
    const result = await financialService.documentRegister(actor(req).id, req.validatedQuery);
    return res.status(200).json({ success: true, data: result });
}





/* ------------------------ customer credit ------------------------ */

export async function getCustomerCredit(req, res) {
    const result = await creditService.getCustomerCredit(actor(req), req.validatedId);
    return res.status(200).json({ success: true, data: result });
}

export async function grantCustomerCredit(req, res) {
    const result = await creditService.grantCredit(actor(req), req.validatedId, req.validated);
    return res.status(201).json({ success: true, message: 'Customer credit granted', data: result });
}

export async function applyCustomerCredit(req, res) {
    const result = await creditService.applyCustomerCredit(actor(req), req.validatedId, req.validated);
    return res.status(200).json({ success: true, message: 'Customer credit applied', data: result });
}

export async function reverseCreditEntry(req, res) {
    const result = await creditService.reverseCreditEntry(actor(req), req.validatedRelatedId, req.validated);
    return res.status(200).json({
        success: true,
        message: 'Credit ledger entry reversed',
        data: result,
    });
}
