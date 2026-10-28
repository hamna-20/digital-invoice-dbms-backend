/**
 * Settlement policy: the one place where the business rules live.
 *
 * Option 1 model (current):
 *   Credit given (udhaar) is added to the invoice's unpaid amount.
 *   It does not change the customer's advance balance.
 *
 *   E   = T - R                       (R = approved return value)
 *   due = E + C                       (C = credit given on this invoice)
 *   U   = max(0, due - P - A - other)
 *   X   = max(0, P + A + other - due)
 *
 * All money is integer paisa.
 */

export const SETTLEMENT_POLICY = Object.freeze({
    /** Credit given (udhaar) is NOT limited by excess cash. */
    creditRequiresExcess: false,
    /** Udhaar increases the invoice's unpaid amount. */
    creditAddsToUnpaid: true,
    /** A return reduces the unpaid amount first; the leftover becomes customer return credit. */
    returnSettlementOrder: Object.freeze(['unpaid', 'customer_credit']),
    settleReturnOnApproval: true,
    leftoverRoute: 'customer_credit',
    returnableSource: 'invoice_lines',
});

function clamp(value) {
    return value > 0 ? value : 0;
}

/**
 * Core invoice money state. Inputs are integer paisa.
 *
 * @param {{totalPaisa?:number, returnValuePaisa?:number, paidPaisa?:number,
 *          appliedPaisa?:number, otherCreditPaisa?:number, creditGivenPaisa?:number}} parts
 */
export function computeMoneyState({
    totalPaisa = 0,
    returnValuePaisa = 0,
    paidPaisa = 0,
    appliedPaisa = 0,
    otherCreditPaisa = 0,
    creditGivenPaisa = 0,
} = {}) {
    const invoiceTotalPaisa = clamp(Math.trunc(totalPaisa));
    const returnValue = clamp(Math.trunc(returnValuePaisa));
    const paid = clamp(Math.trunc(paidPaisa));
    const applied = clamp(Math.trunc(appliedPaisa));
    const otherCredit = clamp(Math.trunc(otherCreditPaisa));
    const creditGiven = clamp(Math.trunc(creditGivenPaisa));

    // Udhaar is part of the bill, not added on top of it.
    const effectiveTotalPaisa = Math.max(0, invoiceTotalPaisa - returnValue);
    const amountDuePaisa = effectiveTotalPaisa;
    const settledPaisa = paid + applied + otherCredit;
    const unpaidPaisa = Math.max(0, amountDuePaisa - settledPaisa);
    const excessPaisa = Math.max(0, settledPaisa - amountDuePaisa);
    const creditOutstandingPaisa = Math.min(creditGiven, unpaidPaisa);

    return {
        invoiceTotalPaisa,
        returnValuePaisa: returnValue,
        effectiveTotalPaisa,
        creditGivenPaisa: creditGiven,
        creditOutstandingPaisa,
        amountDuePaisa,
        paidPaisa: paid,
        appliedPaisa: applied,
        otherCreditPaisa: otherCredit,
        settledPaisa,
        unpaidPaisa,
        excessPaisa,
    };
}

/**
 * Validates a credit (udhaar) amount on a payment save.
 * Option 1: no excess-cash rule. Only the amount must be non-negative,
 * and the reason is checked by the service and the validator.
 */
export function validateCreditIssuance({ creditPaisa = 0 } = {}) {
    if (!Number.isSafeInteger(creditPaisa) || creditPaisa < 0) {
        return { ok: false, message: 'Credit amount must be zero or more.' };
    }
    return { ok: true };
}

/**
 * Return settlement under option 1.
 * The return value first reduces the unpaid amount (which already includes
 * udhaar). Anything left over becomes customer return credit.
 *
 * @returns {{unpaidReductionPaisa:number, customerCreditPaisa:number}}
 */
export function planReturnSettlement({
    returnValuePaisa = 0,
    unpaidBeforePaisa = 0,
    unpaidAfterPaisa = 0,
} = {}) {
    const value = clamp(Math.trunc(returnValuePaisa));
    const before = clamp(Math.trunc(unpaidBeforePaisa));
    const after = clamp(Math.trunc(unpaidAfterPaisa));

    const unpaidReductionPaisa = Math.min(value, Math.max(0, before - after));
    const customerCreditPaisa = value - unpaidReductionPaisa;

    return { unpaidReductionPaisa, customerCreditPaisa };
}

/**
 * Returnable quantity per invoice line.
 * returnable = invoiced - approved returned - pending/draft reserved (never below 0)
 *
 * @returns {Map<number, {returned:number, reserved:number, returnable:number}>}
 */
export function computeReturnQuantities(invoiceItems, returns = []) {
    const state = new Map();
    for (const item of invoiceItems || []) {
        state.set(item.id, { returned: 0, reserved: 0, returnable: Math.max(0, item.quantity) });
    }

    for (const record of returns || []) {
        if (record.status !== 'approved' && record.status !== 'pending' && record.status !== 'draft') continue;
        for (const line of record.items || []) {
            const entry = state.get(line.invoiceItemId);
            if (!entry) continue;
            if (record.status === 'approved') entry.returned += line.quantity;
            else entry.reserved += line.quantity;
        }
    }

    for (const item of invoiceItems || []) {
        const entry = state.get(item.id);
        entry.returnable = Math.max(0, item.quantity - entry.returned - entry.reserved);
    }
    return state;
}

/**
 * Status badges. Several can apply together. Draft, cancelled and void are exclusive.
 */
export function deriveBadges({
    storedStatus,
    overdue = false,
    hasReturn = false,
    creditIssuedPaisa = 0,
    returnCreditPaisa = 0,
    money,
}) {
    if (storedStatus === 'draft') return ['draft'];
    if (storedStatus === 'cancelled') return ['cancelled'];
    if (storedStatus === 'void') return ['void'];

    const badges = [];
    const { effectiveTotalPaisa, settledPaisa, unpaidPaisa } = money;

    if (unpaidPaisa === 0 && effectiveTotalPaisa > 0) badges.push('paid');
    if (settledPaisa > 0 && unpaidPaisa > 0) badges.push('partially_paid');
    if (settledPaisa === 0 && unpaidPaisa > 0 && !overdue) badges.push('issued');
    if (unpaidPaisa > 0 && overdue) badges.push('overdue');
    if (unpaidPaisa > 0 && (creditIssuedPaisa > 0 || returnCreditPaisa > 0)) badges.push('credit');
    if (hasReturn) badges.push('return');

    return badges;
}

/** True when a return still holds quantity (pending, draft or approved). */
export function hasActiveReturn(returns = []) {
    return (returns || []).some(
        (record) =>
            (record.status === 'pending' || record.status === 'draft' || record.status === 'approved') &&
            (record.items || []).some((line) => line.quantity > 0)
    );
}