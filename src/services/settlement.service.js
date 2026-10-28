import { toAmount, toPaisa, ZERO_PAISA } from '../utils/money.js';
import { computeMoneyState, deriveBadges, hasActiveReturn } from './settlement.policy.js';

/**
 * Single financial calculation service (Option 1: udhaar goes to the invoice).
 *
 *   T = invoice total
 *   R = approved return value
 *   E = T - R
 *   C = credit given on this invoice (udhaar, 'issued' rows)
 *   P = cash paid (completed payments)
 *   A = customer advance applied to this invoice
 *   due    = E + C
 *   unpaid = max(0, due - P - A - other)
 *
 * Udhaar does NOT change the customer's advance balance.
 */

const TERMINAL_STATUS = new Set(['draft', 'void', 'cancelled']);

export function deriveStatus(storedStatus, settlement) {
    if (TERMINAL_STATUS.has(storedStatus)) return storedStatus;
    if (settlement.unpaidPaisa <= 0) return 'paid';
    return settlement.settledPaisa > 0 ? 'partially_paid' : 'issued';
}

export function settlementFromRows(invoice) {
    const paidPaisa = (invoice.payments || [])
        .filter((payment) => payment.status === 'completed')
        .reduce((total, payment) => total + toPaisa(payment.amount), ZERO_PAISA);

    // Legacy credit notes only (new flows do not create them).
    const otherCreditPaisa = (invoice.creditNotes || []).reduce(
        (total, note) => total + toPaisa(note.appliedAmount),
        ZERO_PAISA
    );

    // Customer advance applied to this invoice.
    const customerCreditPaisa = (invoice.creditApplications || []).reduce(
        (total, application) => total + toPaisa(application.amount),
        ZERO_PAISA
    );

    // R: approved return value, tax included.
    let returnValuePaisa = ZERO_PAISA;
    for (const record of invoice.returns || []) {
        if (record.status === 'approved') returnValuePaisa += toPaisa(record.totalAmount);
    }

    // C: udhaar on this invoice. K: return credit held by the customer.
    let creditGivenPaisa = ZERO_PAISA;
    let returnCreditPaisa = ZERO_PAISA;
    for (const entry of invoice.creditEntries || []) {
        const amount = toPaisa(entry.amount);
        if (entry.entryType === 'issued') creditGivenPaisa += amount;
        else if (entry.entryType === 'return_credit') returnCreditPaisa += amount;
        else if (entry.entryType === 'cashout') returnCreditPaisa -= amount;
    }

    const originalTotalPaisa = toPaisa(invoice.grandTotal);
    const money = computeMoneyState({
        totalPaisa: originalTotalPaisa,
        returnValuePaisa,
        paidPaisa,
        appliedPaisa: customerCreditPaisa,
        otherCreditPaisa,
        creditGivenPaisa,
    });

    const terminal = TERMINAL_STATUS.has(invoice.status);
    const unpaidPaisa = terminal ? ZERO_PAISA : money.unpaidPaisa;
    const excessPaisa = terminal ? ZERO_PAISA : money.excessPaisa;

    const settlement = {
        invoiceId: invoice.id,
        storedStatus: invoice.status,
        invoiceTotalPaisa: originalTotalPaisa,
        originalTotalPaisa,
        effectiveTotalPaisa: money.effectiveTotalPaisa,
        amountDuePaisa: money.amountDuePaisa,
        returnValuePaisa,
        paidPaisa,
        appliedPaisa: customerCreditPaisa,
        customerCreditPaisa,
        otherCreditPaisa,
        creditsAppliedPaisa: customerCreditPaisa + otherCreditPaisa,
        creditGivenPaisa,
        creditIssuedPaisa: creditGivenPaisa,
        returnCreditPaisa,
        invoiceReturnCreditPaisa: returnCreditPaisa,
        settledPaisa: money.settledPaisa,
        unpaidPaisa,
        outstandingPaisa: unpaidPaisa,
        excessPaisa,
        hasSettlement: money.settledPaisa > 0,
    };

    return { ...settlement, status: deriveStatus(invoice.status, settlement) };
}

export function statusBadges(invoice, settlement, today = startOfUtcToday()) {
    const overdue =
        (settlement.storedStatus === 'issued' || settlement.storedStatus === 'partially_paid') &&
        settlement.unpaidPaisa > 0 &&
        isOverdueDueDate(invoice.dueDate, today);

    return deriveBadges({
        storedStatus: settlement.storedStatus,
        overdue,
        hasReturn: hasActiveReturn(invoice.returns),
        creditIssuedPaisa: settlement.creditGivenPaisa,
        returnCreditPaisa: settlement.returnCreditPaisa,
        money: settlement,
    });
}

function startOfUtcToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isOverdueDueDate(dueDate, today) {
    if (!dueDate) return false;
    const parsed = dueDate instanceof Date ? dueDate : new Date(dueDate);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.getTime() < today.getTime();
}

export function settlementSelect() {
    return {
        id: true,
        status: true,
        dueDate: true,
        grandTotal: true,
        payments: { select: { amount: true, status: true } },
        creditNotes: { select: { appliedAmount: true, returnId: true } },
        creditApplications: { select: { amount: true } },
        returns: {
            select: {
                id: true,
                status: true,
                totalAmount: true,
                items: { select: { quantity: true } },
            },
        },
        creditEntries: { select: { entryType: true, amount: true } },
    };
}

export async function loadSettlement(tx, invoiceId) {
    const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: settlementSelect(),
    });
    return invoice ? settlementFromRows(invoice) : null;
}

export async function refreshStatus(tx, invoiceId) {
    const settlement = await loadSettlement(tx, invoiceId);
    if (!settlement) return null;
    if (TERMINAL_STATUS.has(settlement.storedStatus)) return settlement;

    const current = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { paidAt: true },
    });

    const data = {};
    if (settlement.status !== settlement.storedStatus) data.status = settlement.status;
    if (settlement.status === 'paid' && !current?.paidAt) data.paidAt = new Date();
    if (settlement.status !== 'paid' && current?.paidAt) data.paidAt = null;

    if (Object.keys(data).length > 0) {
        await tx.invoice.update({ where: { id: invoiceId }, data });
    }
    return settlement;
}

export function serializeSettlement(settlement) {
    if (!settlement) return null;
    const unpaid = toAmount(settlement.unpaidPaisa);
    return {
        originalTotal: toAmount(settlement.originalTotalPaisa),
        effectiveTotal: toAmount(settlement.effectiveTotalPaisa),
        amountDue: toAmount(settlement.amountDuePaisa),
        returnValueSettled: toAmount(settlement.returnValuePaisa),
        amountPaid: toAmount(settlement.paidPaisa),
        creditGiven: toAmount(settlement.creditGivenPaisa),
        creditIssued: toAmount(settlement.creditGivenPaisa),
        customerCreditApplied: toAmount(settlement.customerCreditPaisa),
        returnCredit: toAmount(settlement.returnCreditPaisa),
        invoiceReturnCredit: toAmount(settlement.returnCreditPaisa),
        otherCreditApplied: toAmount(settlement.otherCreditPaisa),
        creditsApplied: toAmount(settlement.creditsAppliedPaisa),
        unpaid,
        outstanding: unpaid,
        excess: toAmount(settlement.excessPaisa),
        originalTotalPaisa: settlement.originalTotalPaisa,
        effectiveTotalPaisa: settlement.effectiveTotalPaisa,
        amountDuePaisa: settlement.amountDuePaisa,
        returnValuePaisa: settlement.returnValuePaisa,
        amountPaidPaisa: settlement.paidPaisa,
        creditGivenPaisa: settlement.creditGivenPaisa,
        creditIssuedPaisa: settlement.creditGivenPaisa,
        customerCreditAppliedPaisa: settlement.customerCreditPaisa,
        returnCreditPaisa: settlement.returnCreditPaisa,
        otherCreditAppliedPaisa: settlement.otherCreditPaisa,
        creditsAppliedPaisa: settlement.creditsAppliedPaisa,
        unpaidPaisa: settlement.unpaidPaisa,
        outstandingPaisa: settlement.unpaidPaisa,
        excessPaisa: settlement.excessPaisa,
        status: settlement.status,
    };
}

/* ------------------------------------------------------------------ *
 * Return credit (customer money)
 * ------------------------------------------------------------------ */

export async function loadReturnCredit(tx, returnId) {
    const credit = await tx.returnCredit.findUnique({
        where: { returnId },
        select: { id: true, approvedAmount: true, returnId: true, invoiceId: true, customerId: true },
    });
    if (!credit) return null;

    const movedToCustomer = await tx.customerCreditEntry.aggregate({
        where: { sourceReturnId: returnId, entryType: 'credit_added' },
        _sum: { amount: true },
    });

    const approvedPaisa = toPaisa(credit.approvedAmount);
    const toCustomerCreditPaisa = toPaisa(movedToCustomer._sum.amount);

    return {
        id: credit.id,
        returnId: credit.returnId,
        invoiceId: credit.invoiceId,
        customerId: credit.customerId,
        approvedPaisa,
        appliedToInvoicePaisa: 0,
        toCustomerCreditPaisa,
        allocatedPaisa: toCustomerCreditPaisa,
        availablePaisa: Math.max(ZERO_PAISA, approvedPaisa - toCustomerCreditPaisa),
        settledPaisa: toCustomerCreditPaisa,
    };
}

export function serializeReturnCredit(credit) {
    if (!credit) return null;
    return {
        id: credit.id,
        returnId: credit.returnId,
        invoiceId: credit.invoiceId,
        customerId: credit.customerId,
        approvedAmount: toAmount(credit.approvedPaisa),
        approvedAmountPaisa: credit.approvedPaisa,
        appliedToInvoice: toAmount(credit.appliedToInvoicePaisa),
        appliedToInvoicePaisa: credit.appliedToInvoicePaisa,
        toCustomerCredit: toAmount(credit.toCustomerCreditPaisa),
        toCustomerCreditPaisa: credit.toCustomerCreditPaisa,
        allocated: toAmount(credit.allocatedPaisa),
        allocatedPaisa: credit.allocatedPaisa,
        available: toAmount(credit.availablePaisa),
        availablePaisa: credit.availablePaisa,
        fullySettled: credit.availablePaisa === 0,
    };
}

/* ------------------------------------------------------------------ *
 * Customer advance balance
 * ------------------------------------------------------------------ */

/**
 * Effect of each ledger row on the customer's ADVANCE balance.
 * 'issued' (udhaar) is 0: it is owed by the customer on an invoice, not an advance.
 */
export const CREDIT_ENTRY_EFFECT = {
    credit_added: 1,
    credit_applied: -1,
    reversal_added: -1,
    reversal_applied: 1,
    issued: 0,
    applied: -1,
    return_credit: 1,
    cashout: -1,
    adjustment: 1,
};

export const CREDIT_ENTRY_TYPES = Object.freeze([
    'credit_added',
    'credit_applied',
    'reversal_added',
    'reversal_applied',
    'issued',
    'applied',
    'return_credit',
    'cashout',
    'adjustment',
]);

export async function customerCreditAvailablePaisa(tx, customerId) {
    const entries = await tx.customerCreditEntry.findMany({
        where: { customerId },
        select: { entryType: true, amount: true },
    });
    return entries.reduce(
        (total, entry) => total + (CREDIT_ENTRY_EFFECT[entry.entryType] ?? 0) * toPaisa(entry.amount),
        ZERO_PAISA
    );
}

export async function customerCreditSummary(tx, customerId) {
    const entries = await tx.customerCreditEntry.findMany({
        where: { customerId },
        select: { entryType: true, amount: true },
    });

    let addedPaisa = ZERO_PAISA;
    let appliedPaisa = ZERO_PAISA;
    let reversedPaisa = ZERO_PAISA;
    for (const entry of entries) {
        if (entry.entryType === 'issued') continue; // udhaar is not part of the advance balance
        const amount = toPaisa(entry.amount);
        if (entry.entryType === 'credit_added' || entry.entryType === 'return_credit') {
            addedPaisa += amount;
        } else if (
            entry.entryType === 'credit_applied' ||
            entry.entryType === 'applied' ||
            entry.entryType === 'cashout'
        ) {
            appliedPaisa += amount;
        } else {
            reversedPaisa += amount;
        }
    }

    const availablePaisa = entries.reduce(
        (total, entry) => total + (CREDIT_ENTRY_EFFECT[entry.entryType] ?? 0) * toPaisa(entry.amount),
        ZERO_PAISA
    );

    return { addedPaisa, appliedPaisa, reversedPaisa, availablePaisa };
}