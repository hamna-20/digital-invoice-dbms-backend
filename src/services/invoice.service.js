import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';
import { toAmount, toDecimal, toPaisa, ZERO_PAISA } from '../utils/money.js';
import { can } from '../utils/permissions.js';
import { parseSnapshot, writeAudit } from './audit.service.js';
import { loadSettlement, refreshStatus, serializeSettlement, settlementFromRows, settlementSelect, statusBadges, CREDIT_ENTRY_EFFECT } from './settlement.service.js';
import { computeReturnQuantities } from './settlement.policy.js';

/**
 * Invoice business logic.
 *
 * Money rules (documented policy):
 *   lineSubtotal = round2(quantity x unitPrice)
 *   lineTax      = round2(lineSubtotal x taxRate / 100)
 *   lineTotal    = lineSubtotal + lineTax
 *   invoice      = sum of the rounded line values
 *
 * Rounding is ROUND_HALF_UP to 2 decimals and happens per line, so the line
 * items always add up to the invoice totals exactly. All currency maths uses
 * Prisma.Decimal (decimal.js); JavaScript floating point is never used.
 *
 * Numbering uses the single InvoiceCounters row. The increment happens inside
 * the same transaction as the insert, so concurrent requests serialise on the
 * row lock and a rolled-back insert also rolls the counter back (no gaps).
 *
 * Overdue is derived at read time: an issued invoice whose due date is before
 * today is reported as "overdue". The stored status stays "issued", which is
 * what payment/cancellation transitions act on.
 */

const DECIMAL_ZERO = new Prisma.Decimal(0);
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

const round2 = (value) => new Prisma.Decimal(value).toDecimalPlaces(2, ROUND_HALF_UP);
const toNumber = (value) => (value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value));

const customerSelect = {
    id: true,
    name: true,
    email: true,
    phone: true,
    companyName: true,
    taxNumber: true,
    registration: true,
    address: true,
    city: true,
};

const itemSelect = {
    id: true,
    productId: true,
    productName: true,
    productCode: true,
    quantity: true,
    unitPrice: true,
    taxRate: true,
    lineSubtotal: true,
    lineTax: true,
    lineTotal: true,
};

const invoiceSelect = {
    id: true,
    invoiceNumber: true,
    customerId: true,
    invoiceDate: true,
    dueDate: true,
    status: true,
    subtotal: true,
    taxTotal: true,
    grandTotal: true,
    notes: true,
    paidAt: true,
    issuedAt: true,
    issuedBy: true,
    voidedAt: true,
    voidReason: true,
    voidedBy: true,
    createdAt: true,
    updatedAt: true,
    version: true,
    creditEntries: { select: { entryType: true, amount: true } },
    user: { select: { fullName: true, email: true } },
    issuer: { select: { fullName: true, email: true } },
    voider: { select: { fullName: true, email: true } },
    customer: { select: customerSelect },
    items: { select: itemSelect, orderBy: { id: 'asc' } },
    payments: {
        orderBy: { paymentDate: 'desc' }, select: {
            id: true,
            paymentDate: true,
            amount: true,
            method: true,
            reference: true,
            status: true,
            notes: true,
            createdBy: true,
            createdAt: true,
            creator: { select: { fullName: true, email: true } },
        }
    },
    activities: {
        orderBy: { createdAt: 'desc' }, select: {
            id: true,
            eventType: true,
            description: true,
            amount: true,
            createdAt: true,
            actor: { select: { fullName: true } },
        }
    },
    returns: {
        orderBy: { returnDate: 'desc' }, select: {
            id: true,
            returnNumber: true,
            returnDate: true,
            reason: true,
            status: true,
            subtotal: true,
            taxTotal: true,
            totalAmount: true,
            createdBy: true,
            approvedAt: true,
            items: true,
            credit: { select: { approvedAmount: true } },
        }
    },
    creditNotes: {
        orderBy: { issueDate: 'desc' }, select: {
            id: true,
            returnId: true,
            creditNumber: true,
            issueDate: true,
            reason: true,
            subtotal: true,
            taxTotal: true,
            totalAmount: true,
            appliedAmount: true,
            status: true,
        }
    },
    creditApplications: {
        orderBy: { appliedAt: 'desc' }, select: {
            id: true,
            amount: true,
            appliedAt: true,
            customerCreditEntryId: true,
            actor: { select: { fullName: true } },
        }
    },
};

function startOfUtcToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toDateOnly(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

/**
 * API status. The money state always comes from the settlement engine; 'overdue'
 * is a read-only presentation of an issued/partially-paid invoice whose due
 * date has passed and is never stored.
 */
function effectiveStatus(invoice) {
    const status = settlementFromRows(invoice).status;
    if (isOverdue(invoice, status)) return 'overdue';
    return status;
}

function isOverdue(invoice, status) {
    if (status !== 'issued' && status !== 'partially_paid') return false;
    if (!invoice.dueDate) return false;
    const dueDate = invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate);
    if (Number.isNaN(dueDate.getTime())) return false;
    return dueDate.getTime() < startOfUtcToday().getTime();
}

/**
 * Every status an invoice matches, most prominent first: the derived money
 * badges from the status engine (Section D) — an invoice can be
 * ['partially_paid', 'overdue'] or ['paid', 'return', 'credit'] at the same
 * time, and each badge is a valid list filter.
 */
function statusTags(invoice) {
    return statusBadges(invoice, settlementFromRows(invoice));
}

/**
 * What this invoice currently allows, derived from its money state so the
 * client never has to re-implement the rules (and never shows a button that
 * would answer 409).
 *
 * `editable` is the headline rule the API guarantees: an invoice stays
 * editable until it is fully paid, and a cancelled or void invoice is locked
 * for ever. `allowedActions` spells out the transitions available right now.
 */
function invoiceActions(invoice, status) {
    const editable = status !== 'paid' && status !== 'void' && status !== 'cancelled';
    const stored = invoice.status;
    const settlement = settlementFromRows(invoice);

    const actions = [];
    if (editable) actions.push('edit');
    if (stored === 'draft') actions.push('issue');
    if (editable && settlement.outstandingPaisa > 0) actions.push('pay');
    if (stored === 'draft' || stored === 'issued') {
        actions.push('cancel');
        actions.push('void');
    }
    if (['issued', 'partially_paid', 'paid'].includes(status)) actions.push('return');
    if (stored === 'draft' || stored === 'cancelled') actions.push('delete');

    return { editable, allowedActions: actions };
}

/**
 * Ledger rows that moved approved return credit out of this invoice and into
 * the customer's credit balance. One groupBy for a whole page of invoices.
 */
async function loadReturnCreditTransfers(invoices) {
    const returnIds = invoices.flatMap((invoice) =>
        (invoice.returns || []).filter((record) => record.credit).map((record) => record.id)
    );
    if (returnIds.length === 0) return new Map();

    const rows = await prisma.customerCreditEntry.groupBy({
        by: ['sourceReturnId'],
        where: { sourceReturnId: { in: returnIds }, entryType: 'credit_added' },
        _sum: { amount: true },
    });
    return new Map(rows.map((row) => [row.sourceReturnId, toPaisa(row._sum.amount ?? 0)]));
}

function serializeInvoice(invoice, { returnCreditTransfers = new Map(), creditBalances = null } = {}) {
    const settlement = settlementFromRows(invoice);
    const status = effectiveStatus(invoice);
    const actions = invoiceActions(invoice, status);

    // Per-line return state from ONE calculation (settlement.policy.js,
    // CONFIRM 5): `returnedQuantity` counts approved returns only,
    // `pendingReturnQuantity` is what pending requests reserve, and
    // `returnable` = quantity − returned − pending — exactly the number the
    // "Create physical return" form and its validation use, so the table and
    // the form can never disagree again.
    const returnState = computeReturnQuantities(invoice.items, invoice.returns);

    // Return credit state per return, so the client always knows which step is
    // outstanding instead of having to re-derive the settlement rules.
    const returnRows = (invoice.returns || []).map((record) => {
        const approvedPaisa = record.credit ? toPaisa(record.credit.approvedAmount) : 0;
        const appliedPaisa = (invoice.creditNotes || [])
            .filter((note) => note.returnId === record.id)
            .reduce((total, note) => total + toPaisa(note.appliedAmount), 0);
        const movedPaisa = returnCreditTransfers.get(record.id) || 0;
        const pendingPaisa = record.credit ? Math.max(approvedPaisa - appliedPaisa - movedPaisa, 0) : 0;
        return { record, pendingPaisa };
    });

    const awaitingApproval = returnRows.filter(
        (row) => row.record.status === 'pending' || row.record.status === 'draft'
    );
    const returnCreditPendingPaisa = returnRows.reduce((total, row) => total + row.pendingPaisa, 0);
    const nextStep =
        awaitingApproval.length > 0
            ? 'approve_return'
            : returnCreditPendingPaisa > 0
                ? 'settle_return_credit'
                : null;

    return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        customer: invoice.customer ? { ...invoice.customer } : null,
        invoiceDate: toDateOnly(invoice.invoiceDate),
        dueDate: toDateOnly(invoice.dueDate),
        status,
        statuses: statusTags(invoice),
        editable: actions.editable,
        allowedActions: actions.allowedActions,
        /// Optimistic-concurrency token echoed for "Record payment" saves.
        version: invoice.version,
        subtotal: toNumber(invoice.subtotal),
        taxTotal: toNumber(invoice.taxTotal),
        grandTotal: toNumber(invoice.grandTotal),
        netTotal: toAmount(settlement.effectiveTotalPaisa),
        netTotalPaisa: settlement.effectiveTotalPaisa,
        notes: invoice.notes,
        paidAt: invoice.paidAt,
        issuedAt: invoice.issuedAt ?? null,
        issuedBy: invoice.issuedBy ?? null,
        issuedByName: invoice.issuer?.fullName ?? null,
        voidedAt: invoice.voidedAt ?? null,
        voidReason: invoice.voidReason ?? null,
        voidedBy: invoice.voidedBy ?? null,
        voidedByName: invoice.voider?.fullName ?? null,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        preparedBy: invoice.user
            ? { name: invoice.user.fullName, email: invoice.user.email }
            : { name: null, email: null },
        financialSummary: {
            ...serializeSettlement(settlement),
            // Approved return credit that has not been applied yet: the money
            // that is still going to come back to this invoice.
            returnCreditPending: toAmount(returnCreditPendingPaisa),
            returnCreditPendingPaisa,
        },
        /// Account summary of the invoice detail modal (spec F). Exactly these
        /// five lines — the old "Credit notes applied" line is gone.
        accountSummary: {
            invoiceTotal: toAmount(settlement.invoiceTotalPaisa),
            completedPayments: toAmount(settlement.paidPaisa),
            creditIssued: toAmount(settlement.creditIssuedPaisa),
            returnValueSettled: toAmount(settlement.returnValuePaisa),
            unpaidAmount: toAmount(settlement.unpaidPaisa),
            invoiceTotalPaisa: settlement.invoiceTotalPaisa,
            completedPaymentsPaisa: settlement.paidPaisa,
            creditIssuedPaisa: settlement.creditIssuedPaisa,
            returnValueSettledPaisa: settlement.returnValuePaisa,
            unpaidAmountPaisa: settlement.unpaidPaisa,
        },
        /// Customer credit section (spec F): the customer's ledger balance and
        /// only what was applied to THIS invoice (issued credit shows up in
        /// the balance and in accountSummary.creditIssued, never here).
        customerCredit: (() => {
            if (!creditBalances) return null;
            const balance = creditBalances.get(invoice.customerId) ?? 0;
            return {
                availableBalance: toAmount(balance),
                availableBalancePaisa: balance,
                creditAppliedToInvoice: toAmount(settlement.appliedPaisa),
                creditAppliedToInvoicePaisa: settlement.appliedPaisa,
            };
        })(),
        returnWorkflow: {
            awaitingApproval: awaitingApproval.length,
            awaitingApprovalValue: toAmount(
                awaitingApproval.reduce((total, row) => total + toPaisa(row.record.totalAmount), 0)
            ),
            awaitingSettlement: toAmount(returnCreditPendingPaisa),
            awaitingSettlementPaisa: returnCreditPendingPaisa,
            nextStep,
        },
        payments: (invoice.payments || []).map((payment) => ({
            ...payment,
            paymentDate: toDateOnly(payment.paymentDate),
            amount: toNumber(payment.amount),
            recordedByName: payment.creator?.fullName ?? null,
            creator: undefined,
        })),
        activities: (invoice.activities || []).map((activity) => ({
            ...activity,
            amount: activity.amount === null ? null : toNumber(activity.amount),
            actorName: activity.actor.fullName,
            actor: undefined,
        })),
        returns: returnRows.map(({ record, pendingPaisa }) => ({
            ...record,
            returnDate: toDateOnly(record.returnDate),
            subtotal: toNumber(record.subtotal),
            taxTotal: toNumber(record.taxTotal),
            totalAmount: toNumber(record.totalAmount),
            creditApprovedPaisa: record.credit ? toPaisa(record.credit.approvedAmount) : 0,
            creditPending: toAmount(pendingPaisa),
            creditPendingPaisa: pendingPaisa,
            credit: undefined,
            items: record.items.map((item) => ({
                ...item,
                unitPrice: toNumber(item.unitPrice),
                taxRate: toNumber(item.taxRate),
                subtotal: toNumber(item.subtotal),
                taxAmount: toNumber(item.taxAmount),
                totalAmount: toNumber(item.totalAmount),
            })),
        })),
        creditNotes: (invoice.creditNotes || []).map((credit) => ({
            ...credit,
            issueDate: toDateOnly(credit.issueDate),
            subtotal: toNumber(credit.subtotal),
            taxTotal: toNumber(credit.taxTotal),
            totalAmount: toNumber(credit.totalAmount),
            appliedAmount: toNumber(credit.appliedAmount),
            unappliedAmount: toNumber(credit.totalAmount.sub(credit.appliedAmount)),
        })),
        creditApplications: (invoice.creditApplications || []).map((application) => ({
            id: application.id,
            amount: toNumber(application.amount),
            appliedAt: application.appliedAt,
            appliedByName: application.actor?.fullName ?? null,
        })),
        items: invoice.items.map((item) => {
            const state = returnState.get(item.id) || {
                returned: 0,
                reserved: 0,
                returnable: Math.max(item.quantity, 0),
            };
            return {
                ...item,
                unitPrice: toNumber(item.unitPrice),
                taxRate: toNumber(item.taxRate),
                lineSubtotal: toNumber(item.lineSubtotal),
                lineTax: toNumber(item.lineTax),
                lineTotal: toNumber(item.lineTotal),
                returnedQuantity: state.returned,
                pendingReturnQuantity: state.reserved,
                returnable: state.returnable,
            };
        }),
    };
}

/** Loads every referenced product once and validates ownership + active state. */
async function resolveProducts(userId, items) {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const products = await prisma.product.findMany({
        where: { id: { in: productIds }, userId },
        select: { id: true, name: true, code: true, price: true, taxRate: true, isActive: true },
    });

    const byId = new Map(products.map((product) => [product.id, product]));
    const errors = [];

    items.forEach((item, index) => {
        const product = byId.get(item.productId);
        if (!product) {
            errors.push({ field: `items[${index}].productId`, message: 'Product not found' });
        } else if (!product.isActive) {
            errors.push({ field: `items[${index}].productId`, message: 'Product is not active' });
        }
    });

    if (errors.length > 0) {
        throw ApiError.badRequest('Validation failed', errors);
    }

    return byId;
}

async function assertCustomer(userId, customerId) {
    const customer = await prisma.customer.findFirst({
        where: { id: customerId, userId },
        select: { id: true },
    });

    if (!customer) {
        throw ApiError.badRequest('Validation failed', [
            { field: 'customerId', message: 'Customer not found' },
        ]);
    }
}

/** Builds snapshot lines from database prices, never from client input. */
function buildLines(productsById, items) {
    return items.map((item) => {
        const product = productsById.get(item.productId);
        const unitPrice = new Prisma.Decimal(product.price);
        const taxRate = new Prisma.Decimal(product.taxRate);
        const lineSubtotal = round2(unitPrice.mul(item.quantity));
        const lineTax = round2(lineSubtotal.mul(taxRate).div(100));
        const lineTotal = lineSubtotal.add(lineTax);

        return {
            productId: product.id,
            productName: product.name,
            productCode: product.code,
            quantity: item.quantity,
            unitPrice,
            taxRate,
            lineSubtotal,
            lineTax,
            lineTotal,
        };
    });
}

function sumTotals(lines) {
    const subtotal = lines.reduce((sum, line) => sum.add(line.lineSubtotal), DECIMAL_ZERO);
    const taxTotal = lines.reduce((sum, line) => sum.add(line.lineTax), DECIMAL_ZERO);

    return {
        subtotal: round2(subtotal),
        taxTotal: round2(taxTotal),
        grandTotal: round2(subtotal.add(taxTotal)),
    };
}

async function allocateInvoiceNumber(tx) {
    const counter = await tx.invoiceCounter.update({
        where: { id: 1 },
        data: { nextValue: { increment: 1 } },
    });

    return `INV-${counter.nextValue - 1}`;
}

function statusConflict(action, status) {
    return ApiError.conflict(`Cannot ${action} an invoice with status "${status}".`);
}

async function findStatus(userId, id) {
    const invoice = await prisma.invoice.findFirst({
        where: { id, userId },
        select: {
            status: true,
            dueDate: true,
            grandTotal: true,
            payments: { select: { amount: true, status: true } },
            creditNotes: { select: { appliedAmount: true, returnId: true } },
            creditApplications: { select: { amount: true } },
        },
    });
    if (!invoice) throw ApiError.notFound('Invoice not found');
    return effectiveStatus(invoice);
}

/**
 * Managers and administrators see every invoice; everyone else only sees
 * their own. This is what makes a manager approving or voiding a
 * salesperson's document possible.
 */
function visibleTo(actor) {
    return actor.role === 'manager' || actor.role === 'admin' ? {} : { userId: actor.id };
}

export async function createInvoice(actor, input) {
    const userId = actor.id;
    await assertCustomer(userId, input.customerId);

    const productsById = await resolveProducts(userId, input.items);
    const lines = buildLines(productsById, input.items);
    const totals = sumTotals(lines);

    const invoice = await prisma.$transaction(async (tx) => {
        const invoiceNumber = await allocateInvoiceNumber(tx);

        const created = await tx.invoice.create({
            data: {
                userId,
                invoiceNumber,
                customerId: input.customerId,
                invoiceDate: input.invoiceDate,
                dueDate: input.dueDate ?? null,
                status: 'draft',
                ...totals,
                notes: input.notes ?? null,
                items: { create: lines },
            },
            select: invoiceSelect,
        });
        await tx.invoiceActivity.create({
            data: {
                invoiceId: created.id,
                actorId: userId,
                eventType: 'invoice_created',
                description: 'Invoice draft created',
            },
        });
        await writeAudit(tx, {
            actor,
            action: 'invoice.draft_created',
            documentType: 'invoice',
            documentId: created.id,
            invoiceReference: invoiceNumber,
            after: { status: 'draft', grandTotal: toNumber(totals.grandTotal) },
            amountPaisa: toPaisa(totals.grandTotal),
        });
        return created;
    });

    return serializeInvoice(invoice, {
        creditBalances: await loadCreditBalances([invoice.customerId]),
    });
}

/**
 * Derived credit balance per customer (Σ signed ledger entries — spec H:
 * balances are always computed, never stored). One query serves a whole page.
 */
async function loadCreditBalances(customerIds) {
    const ids = [...new Set(customerIds)].filter((id) => Number.isSafeInteger(id));
    const map = new Map(ids.map((id) => [id, ZERO_PAISA]));
    if (ids.length === 0) return map;

    const entries = await prisma.customerCreditEntry.findMany({
        where: { customerId: { in: ids } },
        select: { customerId: true, entryType: true, amount: true },
    });
    for (const entry of entries) {
        const effect = CREDIT_ENTRY_EFFECT[entry.entryType] ?? 0;
        map.set(entry.customerId, (map.get(entry.customerId) ?? ZERO_PAISA) + effect * toPaisa(entry.amount));
    }
    return map;
}

/**
 * Invoice ids that carry the "Credit" badge: credit issued from the invoice
 * (C > 0) or return credit created from it (> 0). Derived from the ledger so
 * the filter and the chip count always agree.
 */
async function loadCreditBadgeInvoiceIds(baseWhere) {
    const entries = await prisma.customerCreditEntry.findMany({
        where: {
            sourceInvoice: baseWhere,
            entryType: { in: ['issued', 'return_credit', 'cashout'] },
        },
        select: { sourceInvoiceId: true, entryType: true, amount: true },
    });

    const totals = new Map();
    for (const entry of entries) {
        if (entry.sourceInvoiceId === null) continue;
        const current = totals.get(entry.sourceInvoiceId) ?? { credit: ZERO_PAISA, returnCredit: ZERO_PAISA };
        const amount = toPaisa(entry.amount);
        if (entry.entryType === 'issued') current.credit += amount;
        else if (entry.entryType === 'return_credit') current.returnCredit += amount;
        else current.returnCredit -= amount; // cashout
        totals.set(entry.sourceInvoiceId, current);
    }

    return [...totals.entries()]
        .filter(({ 1: value }) => value.credit > 0 || value.returnCredit > 0)
        .map(([id]) => id);
}

/**
 * WHERE clause for one status badge — the exact SQL twin of the badge rules
 * in settlement.policy.js, so chip counts and filtered rows always match
 * (acceptance test 13).
 */
function statusClause(entry, today, creditIds) {
    switch (entry) {
        case 'overdue':
            return { status: { in: ['issued', 'partially_paid'] }, dueDate: { not: null, lt: today } };
        case 'issued':
            // "Pending": nothing settled, still owed, and NOT overdue.
            return { status: 'issued', OR: [{ dueDate: null }, { dueDate: { gte: today } }] };
        case 'partially_paid':
            // The badge applies to overdue partially paid invoices too.
            return { status: 'partially_paid' };
        case 'paid':
        case 'draft':
        case 'cancelled':
        case 'void':
            return { status: entry };
        case 'return':
            // Any return request (pending or approved) still holding quantity.
            return {
                returns: {
                    some: {
                        status: { in: ['pending', 'draft', 'approved'] },
                        items: { some: { quantity: { gt: 0 } } },
                    },
                },
            };
        case 'credit':
            return { id: { in: creditIds }, NOT: { status: 'paid' } };
        default:
            return { status: entry };
    }
}

/**
 * Badge counts for the filter chips, computed over the same base filter as
 * the rows (status excluded, so every chip counts within the same set and an
 * invoice can appear under several chips).
 */
async function buildStatusCounts(baseWhere, today, creditIds) {
    const count = (clause) => prisma.invoice.count({ where: { AND: [baseWhere, clause] } });
    const [all, draft, issued, partiallyPaid, paid, overdue, cancelled, voided, returnRows] = await Promise.all([
        prisma.invoice.count({ where: baseWhere }),
        count({ status: 'draft' }),
        count(statusClause('issued', today, creditIds)),
        count({ status: 'partially_paid' }),
        count({ status: 'paid' }),
        count(statusClause('overdue', today, creditIds)),
        count({ status: 'cancelled' }),
        count({ status: 'void' }),
        count(statusClause('return', today, creditIds)),
    ]);

    return {
        all,
        draft,
        issued,
        partially_paid: partiallyPaid,
        paid,
        overdue,
        cancelled,
        void: voided,
        credit: creditIds.length,
        return: returnRows,
    };
}

export async function listInvoices(actor, { page, limit, search, status, customerId, from, to }) {
    const today = startOfUtcToday();
    const baseAnd = [];

    if (search) {
        baseAnd.push({
            OR: [
                { invoiceNumber: { contains: search } },
                { customer: { name: { contains: search } } },
            ],
        });
    }

    const baseWhere = {
        ...visibleTo(actor),
        ...(customerId ? { customerId } : {}),
        ...(from || to
            ? {
                invoiceDate: {
                    ...(from ? { gte: from } : {}),
                    ...(to ? { lte: to } : {}),
                },
            }
            : {}),
        ...(baseAnd.length ? { AND: baseAnd } : {}),
    };

    // Match-any: an invoice is listed when it carries *any* requested status,
    // and every status now answers to its badge (an invoice can be
    // partially_paid AND overdue AND credit at the same time).
    const requested = Array.isArray(status)
        ? status
        : typeof status === 'string' && status
            ? status.split(',').map((entry) => entry.trim()).filter(Boolean)
            : [];

    // The ledger-derived credit badge serves both the filter and the counts.
    const creditIds = await loadCreditBadgeInvoiceIds(baseWhere);

    const clauses = requested.map((entry) => statusClause(entry, today, creditIds));
    const where = clauses.length > 0 ? { AND: [baseWhere, clauses.length === 1 ? clauses[0] : { OR: clauses }] } : baseWhere;

    const [invoices, total, statusCounts] = await Promise.all([
        prisma.invoice.findMany({
            where,
            select: invoiceSelect,
            orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.invoice.count({ where }),
        buildStatusCounts(baseWhere, today, creditIds),
    ]);

    const [returnCreditTransfers, creditBalances] = await Promise.all([
        loadReturnCreditTransfers(invoices),
        loadCreditBalances(invoices.map((invoice) => invoice.customerId)),
    ]);

    return {
        invoices: invoices.map((invoice) =>
            serializeInvoice(invoice, { returnCreditTransfers, creditBalances })
        ),
        statusCounts,
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getInvoice(actor, id) {
    const invoice = await prisma.invoice.findFirst({
        where: { id, ...visibleTo(actor) },
        select: invoiceSelect,
    });

    if (!invoice) throw ApiError.notFound('Invoice not found');
    const [returnCreditTransfers, creditBalances] = await Promise.all([
        loadReturnCreditTransfers([invoice]),
        loadCreditBalances([invoice.customerId]),
    ]);
    return serializeInvoice(invoice, { returnCreditTransfers, creditBalances });
}

export async function updateInvoice(actor, id, input) {
    const userId = actor.id;
    const existing = await prisma.invoice.findFirst({
        where: { id, userId },
        select: {
            status: true,
            invoiceDate: true,
            dueDate: true,
            invoiceNumber: true,
            grandTotal: true,
            items: { select: { productId: true, quantity: true } },
            payments: { select: { amount: true, status: true } },
            creditNotes: { select: { appliedAmount: true, returnId: true } },
            creditApplications: { select: { amount: true } },
            returns: { select: { id: true, status: true, totalAmount: true } },
            creditEntries: { select: { entryType: true, amount: true } },
        },
    });

    if (!existing) throw ApiError.notFound('Invoice not found');

    // Every stage stays editable until the invoice is fully paid; a cancelled
    // or void invoice is terminal. The money state, not the stored column,
    // decides "fully paid" so a freshly settled invoice locks immediately.
    const before = settlementFromRows(existing);
    if (['paid', 'void', 'cancelled'].includes(before.status)) {
        throw statusConflict('edit', before.status);
    }

    if (input.customerId !== undefined) {
        await assertCustomer(userId, input.customerId);
    }

    // Validate the effective date pair, which may mix new and stored values.
    const invoiceDate = input.invoiceDate !== undefined ? input.invoiceDate : existing.invoiceDate;
    const dueDate = input.dueDate !== undefined ? input.dueDate : existing.dueDate;
    if (dueDate && invoiceDate && dueDate < invoiceDate) {
        throw ApiError.badRequest('Validation failed', [
            { field: 'dueDate', message: 'Due date must be on or after the invoice date' },
        ]);
    }

    let lines = null;
    let totals = null;

    if (input.items !== undefined) {
        const productsById = await resolveProducts(userId, input.items);
        lines = buildLines(productsById, input.items);
        totals = sumTotals(lines);
    }

    await prisma.$transaction(async (tx) => {
        // Conditional claim: edit-vs-pay/void/cancel races never win.
        const claim = await tx.invoice.updateMany({
            where: { id, userId, status: { in: ['draft', 'issued', 'partially_paid'] } },
            data: {
                ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
                ...(input.invoiceDate !== undefined ? { invoiceDate: input.invoiceDate } : {}),
                ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
                ...(input.notes !== undefined ? { notes: input.notes } : {}),
                ...(totals ?? {}),
                updatedAt: new Date(),
            },
        });

        if (claim.count === 0) {
            const current = await tx.invoice.findFirst({
                where: { id, userId },
                select: {
                    status: true,
                    grandTotal: true,
                    payments: { select: { amount: true, status: true } },
                    creditNotes: { select: { appliedAmount: true, returnId: true } },
                    creditApplications: { select: { amount: true } },
                    returns: { select: { id: true, status: true, totalAmount: true } },
                    creditEntries: { select: { entryType: true, amount: true } },
                },
            });
            if (!current) throw ApiError.notFound('Invoice not found');
            throw statusConflict('edit', settlementFromRows(current).status);
        }

        const fresh = await loadSettlement(tx, id);

        if (totals) {
            // Editing an issued invoice must never silently swallow money that
            // has already been received.
            const settledPaisa = fresh.paidPaisa + fresh.creditsAppliedPaisa;
            if (toPaisa(totals.grandTotal) < settledPaisa) {
                throw ApiError.conflict(
                    `The invoice total cannot go below the ${toAmount(settledPaisa)} already settled on it.`
                );
            }

            // Issued invoices already took their stock out, so an edit moves
            // stock by the difference and fails loudly when it cannot.
            if (existing.status !== 'draft') {
                const before2 = new Map();
                for (const item of existing.items) {
                    if (item.productId === null) continue;
                    before2.set(item.productId, (before2.get(item.productId) || 0) + item.quantity);
                }
                const after2 = new Map();
                for (const line of lines) {
                    if (line.productId === null) continue;
                    after2.set(line.productId, (after2.get(line.productId) || 0) + line.quantity);
                }

                for (const productId of new Set([...before2.keys(), ...after2.keys()])) {
                    const delta = (after2.get(productId) || 0) - (before2.get(productId) || 0);
                    if (delta === 0) continue;

                    if (delta > 0) {
                        const updated = await tx.product.updateMany({
                            where: { id: productId, userId, stockQuantity: { gte: delta } },
                            data: { stockQuantity: { decrement: delta } },
                        });
                        if (updated.count === 0) {
                            const product = await tx.product.findFirst({
                                where: { id: productId, userId },
                                select: { name: true },
                            });
                            throw ApiError.conflict(
                                `Insufficient stock for "${product?.name ?? `product ${productId}`}".`
                            );
                        }
                    } else {
                        await tx.product.updateMany({
                            where: { id: productId, userId },
                            data: { stockQuantity: { increment: -delta } },
                        });
                    }
                }
            }
        }

        if (lines) {
            await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
            if (lines.length > 0) {
                await tx.invoiceItem.createMany({
                    data: lines.map((line) => ({ ...line, invoiceId: id })),
                });
            }
        }

        const settled = await refreshStatus(tx, id);

        await writeAudit(tx, {
            actor,
            action: existing.status === 'draft' ? 'invoice.draft_edited' : 'invoice.edited',
            documentType: 'invoice',
            documentId: id,
            invoiceReference: existing.invoiceNumber,
            before: { status: before.status, grandTotal: toNumber(existing.grandTotal) },
            after: {
                status: settled ? settled.status : before.status,
                grandTotal: totals ? toNumber(totals.grandTotal) : toNumber(existing.grandTotal),
            },
            amountPaisa: totals ? toPaisa(totals.grandTotal) : null,
        });
    });

    return getInvoice(actor, id);
}

/**
 * Records cash received (paid) and/or credit given on credit (udhaar).
 *
 *   paid   <= unpaid before this save + credit given in this save
 *   credit has no excess-cash rule; it is added to the invoice's unpaid amount.
 */
export async function recordPayment(actor, id, input) {
    if (!can(actor.role, 'payment.create')) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to record payments (payment.create).`
        );
    }

    const paidInput = input.amount ?? input.paidAmount;
    const paidPaisa =
        paidInput === undefined || paidInput === null || paidInput === '' ? ZERO_PAISA : toPaisa(paidInput);
    const creditPaisa =
        input.creditAmount === undefined || input.creditAmount === null || input.creditAmount === ''
            ? ZERO_PAISA
            : toPaisa(input.creditAmount);

    if (!Number.isSafeInteger(paidPaisa) || !Number.isSafeInteger(creditPaisa) || paidPaisa < 0 || creditPaisa < 0) {
        throw ApiError.badRequest('Amount must be a non-negative value with at most two decimals.');
    }
    if (paidPaisa === ZERO_PAISA && creditPaisa === ZERO_PAISA) {
        throw ApiError.badRequest('Enter a paid amount or a credit amount greater than zero.', [
            { field: 'amount', message: 'Enter a paid amount or credit amount greater than zero' },
        ]);
    }
    if (creditPaisa > ZERO_PAISA && !String(input.creditReason ?? '').trim()) {
        throw ApiError.badRequest('Validation failed', [
            { field: 'creditReason', message: 'Reason is required when a credit amount is entered' },
        ]);
    }

    const idempotencyKey = input.idempotencyKey ? `${id}:${input.idempotencyKey}` : null;
/** True when a save with this idempotency key has already committed. */
   async function isReplayedSave(db, invoiceId, idempotencyKey) {
       if (!idempotencyKey) return false;
       const payment = await db.payment.findFirst({
           where: { invoiceId, idempotencyKey },
           select: { id: true },
       });
       if (payment) return true;
       const entry = await db.customerCreditEntry.findFirst({
           where: { sourceInvoiceId: invoiceId, idempotencyKey },
           select: { id: true },
       });
       return Boolean(entry);
   }

    const hasExpectedVersion = input.expectedVersion !== undefined && input.expectedVersion !== null;

    if (await isReplayedSave(prisma, id, idempotencyKey)) {
        return { invoice: await getInvoice(actor, id), replayed: true };
    }

    const replayed = await prisma.$transaction(async (tx) => {
        const claim = await tx.invoice.updateMany({
            where: {
                id,
                status: { in: ['issued', 'partially_paid', 'paid'] },
                ...(hasExpectedVersion ? { version: input.expectedVersion } : {}),
            },
            data: { updatedAt: new Date(), version: { increment: 1 } },
        });

        if (claim.count === 0) {
            if (await isReplayedSave(tx, id, idempotencyKey)) return true;

            const current = await tx.invoice.findFirst({
                where: { id },
                select: { status: true, version: true },
            });
            if (!current) throw ApiError.notFound('Invoice not found');
            if (hasExpectedVersion && current.version !== input.expectedVersion) {
                throw ApiError.conflict(
                    `This invoice was changed by someone else (version ${current.version}). Reload it and try again.`
                );
            }
            throw statusConflict('record a payment for', current.status);
        }

        const invoice = await tx.invoice.findFirst({
            where: { id },
            select: { id: true, invoiceNumber: true, customerId: true },
        });

        const settlement = await loadSettlement(tx, id);
        if (paidPaisa + creditPaisa > settlement.unpaidPaisa) {
            throw ApiError.conflict(
                `Cash plus credit cannot be more than the unpaid amount of ${toAmount(settlement.unpaidPaisa).toFixed(2)}.`
            );
        }

        let paymentId = null;
        if (paidPaisa > ZERO_PAISA) {
            const payment = await tx.payment.create({
                data: {
                    invoiceId: id,
                    paymentDate: input.paymentDate || new Date(),
                    amount: toDecimal(paidPaisa),
                    method: input.method ?? null,
                    reference: input.reference ?? null,
                    status: 'completed',
                    notes: input.notes ?? null,
                    idempotencyKey,
                    createdBy: actor.id,
                },
            });
            paymentId = payment.id;
        }

        if (creditPaisa > ZERO_PAISA) {
            await tx.customerCreditEntry.create({
                data: {
                    customerId: invoice.customerId,
                    sourceInvoiceId: id,
                    entryType: 'issued',
                    amount: toDecimal(creditPaisa),
                    reference: invoice.invoiceNumber,
                    reason: input.creditReason.trim(),
                    idempotencyKey,
                    createdBy: actor.id,
                },
            });
        }

        const refreshed = await refreshStatus(tx, id);

        await writeAudit(tx, {
            actor,
            action: 'payment.recorded',
            documentType: 'payment',
            documentId: paymentId,
            invoiceReference: invoice.invoiceNumber,
            after: {
                paymentAmount: toAmount(paidPaisa),
                creditGiven: toAmount(creditPaisa),
                outstanding: toAmount(refreshed.unpaidPaisa),
                status: refreshed.status,
            },
            amountPaisa: paidPaisa,
            reason: input.notes ?? null,
        });

        if (creditPaisa > ZERO_PAISA) {
            await writeAudit(tx, {
                actor,
                action: 'credit.given',
                documentType: 'customer_credit',
                documentId: invoice.customerId,
                invoiceReference: invoice.invoiceNumber,
                after: { creditGiven: toAmount(creditPaisa), outstanding: toAmount(refreshed.unpaidPaisa) },
                amountPaisa: creditPaisa,
                reason: input.creditReason.trim(),
            });
        }

        return false;
    });

    const invoice = await getInvoice(actor, id);
    return { invoice, replayed };
}

/**
 * Corrects a completed payment. The new amount may not push the invoice's
 * amount due below what other payments and applied credit already cover.
 */
export async function updatePayment(actor, id, paymentId, input) {
    if (!can(actor.role, 'payment.create')) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to edit payments (payment.create).`
        );
    }

    const amountPaisa = toPaisa(input.amount);
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) {
        throw ApiError.badRequest('Payment amount must be a positive value.');
    }

    await prisma.$transaction(async (tx) => {
        const claim = await tx.invoice.updateMany({
            where: { id, status: { in: ['issued', 'partially_paid', 'paid'] } },
            data: { updatedAt: new Date(), version: { increment: 1 } },
        });
        if (claim.count === 0) {
            const current = await tx.invoice.findFirst({ where: { id }, select: { status: true } });
            if (!current) throw ApiError.notFound('Invoice not found');
            throw statusConflict('edit a payment for', current.status);
        }

        const invoice = await tx.invoice.findFirst({
            where: { id },
            select: { id: true, invoiceNumber: true },
        });

        const payment = await tx.payment.findFirst({
            where: { id: paymentId, invoiceId: id, status: 'completed' },
        });
        if (!payment) {
            throw ApiError.notFound('Payment not found, or it is not a completed payment on this invoice.');
        }

        const settlement = await loadSettlement(tx, id);
        const currentPaisa = toPaisa(payment.amount);
        const otherPaidPaisa = Math.max(settlement.paidPaisa - currentPaisa, 0);

        const headroomPaisa = Math.max(
            settlement.amountDuePaisa - otherPaidPaisa - settlement.appliedPaisa - settlement.otherCreditPaisa,
            0
        );
        if (amountPaisa > headroomPaisa) {
            throw ApiError.conflict(
                `Payment exceeds the remaining amount of ${toAmount(headroomPaisa).toFixed(2)} after the other payments and credits on this invoice.`
            );
        }

        await tx.payment.update({
            where: { id: payment.id },
            data: {
                paymentDate: input.paymentDate,
                amount: toDecimal(amountPaisa),
                method: input.method ?? null,
                reference: input.reference ?? null,
                notes: input.notes ?? null,
                updatedAt: new Date(),
            },
        });

        const refreshed = await refreshStatus(tx, id);

        await writeAudit(tx, {
            actor,
            action: 'payment.edited',
            documentType: 'payment',
            documentId: payment.id,
            invoiceReference: invoice.invoiceNumber,
            before: {
                paymentAmount: toAmount(currentPaisa),
                outstanding: toAmount(settlement.outstandingPaisa),
                status: settlement.status,
            },
            after: {
                paymentAmount: toAmount(amountPaisa),
                outstanding: toAmount(refreshed.outstandingPaisa),
                status: refreshed.status,
            },
            amountPaisa: refreshed.outstandingPaisa,
            reason: input.notes ?? null,
        });
    });

    return getInvoice(actor, id);
}

/**
 * Issues a draft invoice.
 *
 * Issuing is the point where the document becomes real: it records the issuer
 * and timestamp, decrements stock for every product line (aggregating
 * duplicated lines so the guard still holds), and can never be issued twice.
 */
export async function issueInvoice(actor, id) {
    const outcome = await prisma.$transaction(async (tx) => {
        // Claim the draft first. This is the concurrency guard.
        const claim = await tx.invoice.updateMany({
            where: { id, userId: actor.id, status: 'draft' },
            data: { status: 'issued', issuedAt: new Date(), issuedBy: actor.id, updatedAt: new Date() },
        });

        if (claim.count === 0) return { error: 'state' };

        const invoice = await tx.invoice.findFirst({
            where: { id, userId: actor.id },
            select: {
                id: true,
                invoiceNumber: true,
                items: { select: { productId: true, quantity: true } },
            },
        });

        if (!invoice || invoice.items.length === 0) {
            // Throwing rolls the status change back.
            throw ApiError.conflict('An invoice without items cannot be issued.');
        }

        // Aggregate duplicate lines for the same product.
        const demand = new Map();
        for (const item of invoice.items) {
            if (item.productId === null) continue;
            demand.set(item.productId, (demand.get(item.productId) || 0) + item.quantity);
        }

        for (const [productId, quantity] of demand) {
            const updated = await tx.product.updateMany({
                where: { id: productId, userId: actor.id, stockQuantity: { gte: quantity } },
                data: { stockQuantity: { decrement: quantity } },
            });

            if (updated.count === 0) {
                const product = await tx.product.findFirst({
                    where: { id: productId, userId: actor.id },
                    select: { name: true },
                });
                throw ApiError.conflict(
                    `Insufficient stock for "${product?.name ?? `product ${productId}`}".`
                );
            }
        }

        await tx.invoiceActivity.create({
            data: {
                invoiceId: id,
                actorId: actor.id,
                eventType: 'invoice_issued',
                description: 'Invoice issued',
            },
        });

        await writeAudit(tx, {
            actor,
            action: 'invoice.issued',
            documentType: 'invoice',
            documentId: id,
            invoiceReference: invoice.invoiceNumber,
            before: { status: 'draft' },
            after: { status: 'issued' },
        });

        return { ok: true };
    });

    if (outcome.error === 'state') {
        const status = await findStatus(actor.id, id);
        throw statusConflict('issue', status);
    }

    return getInvoice(actor, id);
}

/** Legacy convenience action: settles the remaining balance in one payment. */
export async function payInvoice(actor, id) {
    const invoice = await prisma.invoice.findFirst({
        where: { id, status: { in: ['issued', 'partially_paid'] } },
        select: settlementSelect(),
    });
    if (!invoice) {
        const status = await findStatus(actor.id, id);
        throw statusConflict('mark as paid', status);
    }

    const settlement = settlementFromRows(invoice);
    if (settlement.unpaidPaisa <= 0) {
        throw ApiError.conflict('This invoice has no unpaid amount.');
    }
    const { invoice: saved } = await recordPayment(actor, id, {
        amount: toNumber(toDecimal(settlement.unpaidPaisa)),
        paymentDate: new Date(),
        notes: 'Payment recorded using the legacy mark-as-paid action',
    });
    return saved;
}

/**
 * Cancels an invoice.
 *
 * Cancelling is the everyday counterpart of voiding: any staff member may
 * cancel their own draft or issued invoice, the document is kept for history
 * and is excluded from sales totals. Invoices with money attached (paid or
 * partially paid) cannot be cancelled — payments cannot be reversed, so those
 * go through the authorised void workflow instead.
 */
export async function cancelInvoice(actor, id) {
    if (!can(actor.role, 'invoice.cancel')) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to cancel invoices (invoice.cancel).`
        );
    }

    const outcome = await prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
            where: { id, userId: actor.id },
            select: {
                id: true,
                invoiceNumber: true,
                status: true,
                items: { select: { productId: true, quantity: true } },
            },
        });
        if (!invoice) return { error: 'missing' };

        if (invoice.status !== 'draft' && invoice.status !== 'issued') {
            return { error: 'state', status: invoice.status };
        }

        const claim = await tx.invoice.updateMany({
            where: { id, userId: actor.id, status: invoice.status },
            data: { status: 'cancelled', updatedAt: new Date() },
        });
        if (claim.count === 0) return { error: 'state', status: invoice.status };

        await tx.invoiceActivity.create({
            data: {
                invoiceId: id,
                actorId: actor.id,
                eventType: 'invoice_cancelled',
                description: 'Invoice cancelled',
            },
        });

        // Issuing decremented stock, so cancelling an issued invoice restores it.
        if (invoice.status === 'issued') {
            const demand = new Map();
            for (const item of invoice.items) {
                if (item.productId === null) continue;
                demand.set(item.productId, (demand.get(item.productId) || 0) + item.quantity);
            }

            for (const [productId, quantity] of demand) {
                await tx.product.updateMany({
                    where: { id: productId, userId: actor.id },
                    data: { stockQuantity: { increment: quantity } },
                });
            }
        }

        await writeAudit(tx, {
            actor,
            action: 'invoice.cancelled',
            documentType: 'invoice',
            documentId: id,
            invoiceReference: invoice.invoiceNumber,
            before: { status: invoice.status },
            after: { status: 'cancelled' },
        });

        return { ok: true };
    });

    if (outcome.error === 'missing') throw ApiError.notFound('Invoice not found');
    if (outcome.error === 'state') throw statusConflict('cancel', outcome.status);

    return getInvoice(actor, id);
}

/**
 * Voids an invoice through the authorised workflow.
 *
 * Voiding is only allowed while the invoice has no financial history at all:
 * no completed payments, no approved returns and no applied credit. When it is
 * blocked the error names exactly what must be settled or reversed first.
 * The invoice and every linked document are retained forever and excluded
 * from sales totals; nothing is ever deleted.
 */
export async function voidInvoice(actor, id, input) {
    if (!can(actor.role, 'invoice.void')) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to void invoices (invoice.void).`
        );
    }

    const outcome = await prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
            where: { id, userId: actor.id },
            select: {
                id: true,
                invoiceNumber: true,
                status: true,
                items: { select: { productId: true, quantity: true } },
            },
        });
        if (!invoice) return { error: 'missing' };

        if (input.confirmNumber !== invoice.invoiceNumber) {
            return { error: 'confirm', expected: invoice.invoiceNumber };
        }

        // Eligibility is checked before the status guard so that a partially
        // paid or otherwise settled invoice explains exactly what must be
        // settled or reversed first instead of a generic status message.
        const [completedPayments, approvedReturns, appliedNotes, appliedCredits] = await Promise.all([
            tx.payment.count({ where: { invoiceId: id, status: 'completed' } }),
            tx.invoiceReturn.findMany({
                where: { invoiceId: id, status: 'approved' },
                select: { returnNumber: true },
            }),
            tx.creditNote.count({ where: { invoiceId: id, appliedAmount: { gt: 0 } } }),
            tx.creditApplication.count({ where: { invoiceId: id } }),
        ]);

        if (completedPayments > 0) {
            return {
                error: 'blocked',
                message: `This invoice has ${completedPayments} completed payment(s). Payments cannot be reversed, so the invoice cannot be voided.`,
            };
        }
        if (approvedReturns.length > 0) {
            return {
                error: 'blocked',
                message: `Return ${approvedReturns.map((row) => row.returnNumber).join(', ')} has been approved against this invoice. Cancel that return first.`,
            };
        }
        if (appliedNotes > 0) {
            return { error: 'blocked', message: 'A credit note has been applied to this invoice. Reverse that application first.' };
        }
        if (appliedCredits > 0) {
            return { error: 'blocked', message: 'Customer credit has been applied to this invoice. Reverse that application first.' };
        }

        if (invoice.status !== 'draft' && invoice.status !== 'issued') {
            return { error: 'state', status: invoice.status };
        }

        const claim = await tx.invoice.updateMany({
            where: { id, userId: actor.id, status: invoice.status },
            data: {
                status: 'void',
                voidedAt: input.voidDate ?? new Date(),
                voidReason: input.reason,
                voidedBy: actor.id,
                updatedAt: new Date(),
            },
        });
        if (claim.count === 0) return { error: 'state', status: invoice.status };

        await tx.invoiceActivity.create({
            data: {
                invoiceId: id,
                actorId: actor.id,
                eventType: 'invoice_voided',
                description: `Invoice voided: ${input.reason}`,
            },
        });

        // Issuing decremented stock, so voiding an issued invoice restores it.
        if (invoice.status === 'issued') {
            const demand = new Map();
            for (const item of invoice.items) {
                if (item.productId === null) continue;
                demand.set(item.productId, (demand.get(item.productId) || 0) + item.quantity);
            }

            for (const [productId, quantity] of demand) {
                await tx.product.updateMany({
                    where: { id: productId, userId: actor.id },
                    data: { stockQuantity: { increment: quantity } },
                });
            }
        }

        await writeAudit(tx, {
            actor,
            action: 'invoice.voided',
            documentType: 'invoice',
            documentId: id,
            invoiceReference: invoice.invoiceNumber,
            before: { status: invoice.status },
            after: { status: 'void' },
            reason: input.reason,
        });

        return { ok: true };
    });

    if (outcome.error === 'missing') throw ApiError.notFound('Invoice not found');
    if (outcome.error === 'confirm') {
        throw ApiError.badRequest('Validation failed', [
            { field: 'confirmNumber', message: `Type "${outcome.expected}" exactly to confirm the void` },
        ]);
    }
    if (outcome.error === 'blocked') throw ApiError.conflict(outcome.message);
    if (outcome.error === 'state') {
        throw ApiError.conflict(`An invoice with status "${outcome.status}" cannot be voided.`);
    }

    return getInvoice(actor, id);
}

/** Drafts and cancelled invoices can be deleted; issued and voided invoices are retained forever. */
export async function deleteInvoice(actor, id) {
    const result = await prisma.invoice.deleteMany({
        where: { id, userId: actor.id, status: { in: ['draft', 'cancelled'] } },
    });

    if (result.count === 0) {
        const status = await findStatus(actor.id, id);
        throw ApiError.conflict(`Only draft or cancelled invoices can be deleted; this one is "${status}".`);
    }
}

/**
 * Full invoice timeline for the History tab and the invoice-history report:
 * every financial event that references this invoice, newest first.
 *
 * `history` is the presentation-ready status timeline: one row per audit event
 * with the running totals *after* that step. It is built here rather than in
 * the browser so every client sees the same money figures and no client has to
 * re-implement the settlement rules.
 */
const HISTORY_ACTION_LABELS = {
    'invoice.draft_created': 'Draft created',
    'invoice.draft_edited': 'Draft updated',
    'invoice.edited': 'Invoice updated',
    'invoice.issued': 'Invoice issued',
    'invoice.cancelled': 'Invoice cancelled',
    'invoice.voided': 'Invoice cancelled',
    'payment.recorded': 'Payment received',
    'payment.edited': 'Payment edited',
    'return.created': 'Return requested',
    'return.edited': 'Return edited',
    'return.approved': 'Return approved',
    'return.rejected': 'Return rejected',
    'return.cancelled': 'Return cancelled',
    'return.credit_applied': 'Return credit applied',
    'return.credit_transferred': 'Return credit moved to customer credit',
    'credit_note.issued': 'Credit note issued',
    'credit_note.applied': 'Credit note applied',
    'customer_credit.applied': 'Customer credit applied',
};

function historyLabel(action) {
    if (HISTORY_ACTION_LABELS[action]) return HISTORY_ACTION_LABELS[action];
    return String(action || '')
        .replaceAll('.', ' ')
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function historyAmount(value) {
    if (value === null || value === undefined || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
}

function moneyOrZero(value) {
    return historyAmount(value) ?? 0;
}

function derivedHistoryStatus(total, settled, previous) {
    if (total > 0 && settled >= total) return 'paid';
    if (settled > 0) return 'partially_paid';
    return previous;
}

function fallbackHistory(invoice) {
    const total = toNumber(invoice.grandTotal) || 0;
    const rows = [];
    const push = (at, action, label, status, userName, outstanding, paid = 0) => {
        if (!at) return;
        rows.push({
            id: `fallback-${action}-${new Date(at).getTime()}`,
            action,
            label,
            at,
            status,
            total,
            paid,
            returnCredit: 0,
            otherCredit: 0,
            customerCredit: 0,
            outstanding,
            userName: userName ?? 'Unknown user',
            userEmail: null,
            amount: null,
            reason: null,
            documentType: 'invoice',
            documentId: invoice.id,
            detail: null,
        });
    };

    push(invoice.createdAt, 'invoice.draft_created', 'Draft created', 'draft', invoice.user?.fullName, total);
    push(invoice.issuedAt, 'invoice.issued', 'Invoice issued', 'issued', invoice.issuer?.fullName, total);
    if (invoice.paidAt) {
        push(invoice.paidAt, 'payment.recorded', 'Invoice paid', 'paid', invoice.issuer?.fullName, 0, total);
    }
    push(invoice.voidedAt, 'invoice.voided', 'Invoice cancelled', 'void', invoice.voider?.fullName, null);

    return rows.sort((first, second) => new Date(first.at) - new Date(second.at));
}

function buildInvoiceHistory(invoice, auditRows, returnLinkedCreditNoteIds) {
    const rows = [...auditRows].sort((first, second) => {
        const firstAt = new Date(first.createdAt).getTime();
        const secondAt = new Date(second.createdAt).getTime();
        return firstAt - secondAt || first.id - second.id;
    });

    let total = toNumber(invoice.grandTotal) || 0;
    let paid = 0;
    let returnCredit = 0;
    let otherCredit = 0;
    let customerCredit = 0;
    let status = 'draft';

    const history = rows.map((row) => {
        const detail = parseSnapshot(row.afterJson) || {};
        const beforeDetail = parseSnapshot(row.beforeJson) || {};
        const rawAmount = row.amount === null ? null : Number(row.amount);

        switch (row.action) {
            case 'invoice.draft_created':
            case 'invoice.draft_edited':
                total = historyAmount(detail.grandTotal) ?? rawAmount ?? total;
                status = 'draft';
                break;
            case 'invoice.issued':
                total = historyAmount(detail.grandTotal) ?? rawAmount ?? total;
                status = 'issued';
                break;
            case 'invoice.edited':
                total = historyAmount(detail.grandTotal) ?? rawAmount ?? total;
                break;
            case 'invoice.cancelled':
                status = 'cancelled';
                break;
            case 'invoice.voided':
                status = 'void';
                break;
            case 'payment.recorded':
                paid += moneyOrZero(detail.paymentAmount);
                status = detail.status
                    || derivedHistoryStatus(total, paid + returnCredit + otherCredit + customerCredit, status);
                break;
            case 'payment.edited': {
                const delta =
                    moneyOrZero(detail.paymentAmount) - moneyOrZero(beforeDetail.paymentAmount);
                paid = Math.max(paid + delta, 0);
                status = detail.status
                    || derivedHistoryStatus(total, paid + returnCredit + otherCredit + customerCredit, status);
                break;
            }
            case 'return.credit_applied':
                returnCredit += moneyOrZero(detail.applied);
                status = derivedHistoryStatus(total, paid + returnCredit + otherCredit + customerCredit, status);
                break;
            case 'credit_note.applied':
                if (returnLinkedCreditNoteIds.has(row.documentId)) {
                    returnCredit += moneyOrZero(detail.applied);
                } else {
                    otherCredit += moneyOrZero(detail.applied);
                }
                status = derivedHistoryStatus(total, paid + returnCredit + otherCredit + customerCredit, status);
                break;
            case 'customer_credit.applied':
                customerCredit += moneyOrZero(detail.applied);
                status = derivedHistoryStatus(total, paid + returnCredit + otherCredit + customerCredit, status);
                break;
            default:
                // Document events (return created/approved, credit note issued,
                // credit transferred) do not change the invoice's own money
                // status, so the previous status is carried forward.
                break;
        }

        const settled = paid + returnCredit + otherCredit + customerCredit;
        const outstanding = status === 'void' || status === 'cancelled'
            ? null
            : historyAmount(detail.outstanding) ?? Math.max(total - settled, 0);

        return {
            id: `audit-${row.id}`,
            action: row.action,
            label: historyLabel(row.action),
            at: row.createdAt,
            status,
            total,
            paid,
            returnCredit,
            otherCredit,
            customerCredit,
            outstanding,
            userName: row.userSnapshotName ?? 'Unknown user',
            userEmail: row.userSnapshotEmail ?? null,
            amount: rawAmount,
            reason: row.reason,
            documentType: row.documentType,
            documentId: row.documentId,
            detail,
        };
    });

    return history.length > 0 ? history : fallbackHistory(invoice);
}

export async function getTimeline(actor, id) {
    const invoice = await prisma.invoice.findFirst({
        where: { id, ...visibleTo(actor) },
        select: {
            id: true,
            invoiceNumber: true,
            grandTotal: true,
            createdAt: true,
            issuedAt: true,
            paidAt: true,
            voidedAt: true,
            user: { select: { fullName: true } },
            issuer: { select: { fullName: true } },
            voider: { select: { fullName: true } },
            creditNotes: { select: { id: true, returnId: true } },
        },
    });
    if (!invoice) throw ApiError.notFound('Invoice not found');

    const [auditRows, activities] = await Promise.all([
        prisma.auditLog.findMany({
            where: { invoiceReference: invoice.invoiceNumber },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.invoiceActivity.findMany({
            where: { invoiceId: id },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, eventType: true, description: true, amount: true, createdAt: true, actor: { select: { fullName: true } } },
        }),
    ]);

    const returnLinkedCreditNoteIds = new Set(
        invoice.creditNotes.filter((note) => note.returnId !== null).map((note) => note.id)
    );

    return {
        invoiceNumber: invoice.invoiceNumber,
        history: buildInvoiceHistory(invoice, auditRows, returnLinkedCreditNoteIds),
        events: auditRows.map((row) => ({
            id: `audit-${row.id}`,
            source: 'audit',
            at: row.createdAt,
            action: row.action,
            documentType: row.documentType,
            documentId: row.documentId,
            userName: row.userSnapshotName ?? 'Unknown user',
            userEmail: row.userSnapshotEmail,
            amount: row.amount === null ? null : Number(row.amount),
            reason: row.reason,
            detail: parseSnapshot(row.afterJson),
        })),
        legacyActivities: activities.map((activity) => ({
            id: `activity-${activity.id}`,
            source: 'activity',
            at: activity.createdAt,
            action: activity.eventType,
            userName: activity.actor.fullName,
            amount: activity.amount === null ? null : Number(activity.amount),
            description: activity.description,
        })),
    };
}
