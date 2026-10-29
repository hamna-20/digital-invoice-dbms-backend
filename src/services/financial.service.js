import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';
import { toAmount, toDecimal, toPaisa } from '../utils/money.js';
import { can } from '../utils/permissions.js';
import { writeAudit } from './audit.service.js';
import {
    customerCreditAvailablePaisa,
    loadReturnCredit,
    loadSettlement,
    refreshStatus,
    serializeReturnCredit,
    settlementFromRows,
} from './settlement.service.js';
import { computeMoneyState, planReturnSettlement } from './settlement.policy.js';
import { getInvoice } from './invoice.service.js';

/**
 * Financial document operations: returns and the document register.
 *
 * Settlement model: approving a return settles it in one transaction
 * (credit clawback, then unpaid reduction, then leftover to customer credit).
 * All arithmetic runs in integer paisa. Every mutation happens inside a
 * transaction and writes an audit row in the same transaction.
 */

const { Decimal } = Prisma;

/** Invoice states that may receive returns. */
const SETTLEABLE_STATUSES = ['issued', 'partially_paid', 'paid'];

function assertPermission(actor, permission) {
    if (!can(actor.role, permission)) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to perform this action (${permission}).`
        );
    }
}

/**
 * Row-level lock on an invoice, taken by touching it so concurrent financial
 * transactions on the same invoice serialise instead of racing.
 */
async function lockInvoice(tx, invoiceId, allowedStatuses = SETTLEABLE_STATUSES) {
    const claim = await tx.invoice.updateMany({
        where: { id: invoiceId, status: { in: allowedStatuses } },
        data: { updatedAt: new Date() },
    });
    if (claim.count === 0) return null;
    return tx.invoice.findFirst({
        where: { id: invoiceId },
        select: { id: true, status: true, invoiceNumber: true, customerId: true, userId: true, grandTotal: true },
    });
}

/**
 * Claims the next number for a document sequence. The atomic UPDATE runs
 * inside the caller's transaction, so a rollback also rolls the number back.
 */
async function allocateDocumentNumber(tx, key) {
    const counter = await tx.documentCounter.update({
        where: { key },
        data: { nextValue: { increment: 1 } },
    });
    return `${counter.prefix}${String(counter.nextValue - 1).padStart(4, '0')}`;
}

/** Managers and admins see everything; other users see their own documents. */
export function visibilityFilter(actor) {
    return actor.role === 'manager' || actor.role === 'admin' ? {} : { userId: actor.id };
}

function visibilityScope(actor) {
    return actor.role === 'manager' || actor.role === 'admin' ? {} : { invoice: { userId: actor.id } };
}

function dateOnly(value) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

/* ================================================================== *
 * Returns
 * ================================================================== */

/**
 * Units of each invoiced line still held by other returns. Approved returns
 * are permanent; draft and pending returns reserve quantity until decided.
 */
async function returnableQuantities(tx, invoiceId, invoiceItemIds, { excludeReturnId = null } = {}) {
    const exclude = excludeReturnId ? { id: { not: excludeReturnId } } : {};
    const [approved, reserved] = await Promise.all([
        tx.invoiceReturnItem.findMany({
            where: {
                invoiceItemId: { in: invoiceItemIds },
                invoiceReturn: { invoiceId, status: 'approved', ...exclude },
            },
            select: { invoiceItemId: true, quantity: true },
        }),
        tx.invoiceReturnItem.findMany({
            where: {
                invoiceItemId: { in: invoiceItemIds },
                invoiceReturn: { invoiceId, status: { in: ['pending', 'draft'] }, ...exclude },
            },
            select: { invoiceItemId: true, quantity: true },
        }),
    ]);

    const total = (rows) => {
        const map = new Map();
        for (const row of rows) map.set(row.invoiceItemId, (map.get(row.invoiceItemId) || 0) + row.quantity);
        return map;
    };
    return { approvedByItem: total(approved), reservedByItem: total(reserved) };
}

/** Builds return lines from stored invoice lines, rejecting over-returns. */
async function buildReturnLines(tx, invoiceId, inputItems, excludeReturnId = null) {
    const invoiceItems = await tx.invoiceItem.findMany({
        where: { invoiceId, id: { in: inputItems.map((item) => item.invoiceItemId) } },
    });
    const byId = new Map(invoiceItems.map((item) => [item.id, item]));
    if (byId.size !== inputItems.length) {
        throw ApiError.badRequest('One or more return items do not belong to this invoice.');
    }

    const { approvedByItem, reservedByItem } = await returnableQuantities(
        tx,
        invoiceId,
        inputItems.map((item) => item.invoiceItemId),
        { excludeReturnId }
    );

    const lines = [];
    for (const requested of inputItems) {
        const sold = byId.get(requested.invoiceItemId);
        const alreadyReturned = approvedByItem.get(sold.id) || 0;
        const reservedByOthers = reservedByItem.get(sold.id) || 0;
        const returnable = sold.quantity - alreadyReturned - reservedByOthers;

        if (requested.quantity > returnable) {
            throw ApiError.conflict(
                `Return quantity exceeds the remaining returnable quantity for "${sold.productName}" ` +
                `(invoiced ${sold.quantity}, already returned ${alreadyReturned}, ` +
                `reserved by other returns ${reservedByOthers}, requested ${requested.quantity}).`
            );
        }

        const unitPrice = new Decimal(sold.unitPrice);
        const lineSubtotal = unitPrice.mul(requested.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const lineTax = lineSubtotal.mul(sold.taxRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        lines.push({
            invoiceItemId: sold.id,
            productId: sold.productId,
            productName: sold.productName,
            quantity: requested.quantity,
            disposition: requested.disposition,
            unitPrice,
            taxRate: sold.taxRate,
            subtotal: lineSubtotal,
            taxAmount: lineTax,
            totalAmount: lineSubtotal.add(lineTax),
        });
    }
    return lines;
}

/**
 * Creates a PENDING return. It changes no balance and no stock. It only
 * reserves quantity so overlapping returns cannot over-return the invoice.
 */
export async function createReturn(actor, invoiceId, input) {
    assertPermission(actor, 'return.create');

    return prisma.$transaction(async (tx) => {
        const invoice = await lockInvoice(tx, invoiceId, SETTLEABLE_STATUSES);
        if (!invoice) {
            const current = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { status: true } });
            if (!current) throw ApiError.notFound('Invoice not found');
            throw ApiError.conflict(
                `Returns can only be created for issued, partially paid or paid invoices (current status: "${current.status}").`
            );
        }

        const lines = await buildReturnLines(tx, invoiceId, input.items);
        const subtotal = lines.reduce((sum, line) => sum.add(line.subtotal), new Decimal(0));
        const taxTotal = lines.reduce((sum, line) => sum.add(line.taxAmount), new Decimal(0));

        const settlement = await loadSettlement(tx, invoiceId);

        const returnNumber = await allocateDocumentNumber(tx, 'return');

        const record = await tx.invoiceReturn.create({
            data: {
                invoiceId,
                customerId: invoice.customerId,
                returnNumber,
                returnDate: input.returnDate,
                reason: input.reason,
                status: 'pending',
                subtotal: subtotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                taxTotal: taxTotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                totalAmount: subtotal.add(taxTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                createdBy: actor.id,
                items: { create: lines },
            },
            include: { items: true },
        });

        await writeAudit(tx, {
            actor,
            action: 'return.created',
            documentType: 'return',
            documentId: record.id,
            invoiceReference: invoice.invoiceNumber,
            after: { status: 'pending', totalAmount: toAmount(toPaisa(record.totalAmount)) },
            amountPaisa: toPaisa(record.totalAmount),
            reason: input.reason,
        });

        const totals = subtotal.add(taxTotal);
        let response = { ...serializeReturn(record, invoice.invoiceNumber), credit: null };
        if (toPaisa(totals) > settlement.unpaidPaisa) {
            response.outstandingWarning = true;
            response.outstandingAmount = toAmount(settlement.unpaidPaisa);
        }
        return response;
    });
}

/**
 * Edits a pending or draft return. An approved return has already written
 * ledger entries from its total, so it cannot be edited here.
 */
export async function updateReturn(actor, invoiceId, returnId, input) {
    assertPermission(actor, 'return.create');

    return prisma.$transaction(async (tx) => {
        const invoice = await lockInvoice(tx, invoiceId, SETTLEABLE_STATUSES);
        if (!invoice) {
            const current = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { status: true } });
            if (!current) throw ApiError.notFound('Invoice not found');
            throw ApiError.conflict(
                `Returns can only be edited for issued, partially paid or paid invoices (current status: "${current.status}").`
            );
        }

        const record = await tx.invoiceReturn.findFirst({
            where: { id: returnId, invoiceId },
            include: { items: true, invoice: { select: { invoiceNumber: true, userId: true } } },
        });
        if (!record) throw ApiError.notFound('Return not found');
        if (!['pending', 'draft'].includes(record.status)) {
            throw ApiError.conflict(
                `Return ${record.returnNumber} is "${record.status}" and can no longer be edited. ` +
                'Approved returns are settled, so correct them through a new document.'
            );
        }

        const lines = await buildReturnLines(tx, invoiceId, input.items, returnId);
        const subtotal = lines.reduce((sum, line) => sum.add(line.subtotal), new Decimal(0));
        const taxTotal = lines.reduce((sum, line) => sum.add(line.taxAmount), new Decimal(0));

        const updated = await tx.invoiceReturn.update({
            where: { id: returnId },
            data: {
                returnDate: input.returnDate,
                reason: input.reason,
                subtotal: subtotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                taxTotal: taxTotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                totalAmount: subtotal.add(taxTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                items: { deleteMany: {}, create: lines },
                totalAmount: subtotal.add(taxTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
            },
            include: { items: true },
        });

        await writeAudit(tx, {
            actor,
            action: 'return.edited',
            documentType: 'return',
            documentId: returnId,
            invoiceReference: record.invoice.invoiceNumber,
            before: { status: record.status, totalAmount: toAmount(toPaisa(record.totalAmount)) },
            after: { status: updated.status, totalAmount: toAmount(toPaisa(updated.totalAmount)) },
            amountPaisa: toPaisa(updated.totalAmount),
            reason: input.reason,
        });

        return { ...serializeReturn(updated, record.invoice.invoiceNumber), credit: null };
    });
}

/** Re-checks return quantities against the invoice at approval time. */
async function revalidateReturnItems(tx, record, excludeReturnId = null) {
    const invoiceItems = await tx.invoiceItem.findMany({
        where: { invoiceId: record.invoiceId, id: { in: record.items.map((item) => item.invoiceItemId) } },
    });
    const byId = new Map(invoiceItems.map((item) => [item.id, item]));
    const { approvedByItem } = await returnableQuantities(
        tx,
        record.invoiceId,
        record.items.map((item) => item.invoiceItemId),
        { excludeReturnId }
    );

    for (const item of record.items) {
        const sold = byId.get(item.invoiceItemId);
        if (!sold) {
            throw ApiError.conflict(`The original invoice line for "${item.productName}" no longer exists.`);
        }
        const alreadyApproved = approvedByItem.get(item.invoiceItemId) || 0;
        if (alreadyApproved + item.quantity > sold.quantity) {
            throw ApiError.conflict(
                `Return quantity exceeds the remaining returnable quantity for "${item.productName}" ` +
                `(invoiced ${sold.quantity}, already approved ${alreadyApproved}, requested ${item.quantity}).`
            );
        }
    }
}

/**
 * Approves a pending return exactly once. In one transaction it:
 *   1. marks the return approved;
 *   2. restocks saleable lines (stock incremented, one StockMovement per product);
 *   3. reduces the unpaid amount by the return value; paid amounts are never refunded;
 *   4. refreshes the derived invoice status and bumps the version.
 */
export async function approveReturn(actor, returnId) {
    assertPermission(actor, 'return.approve');

    const outcome = await prisma.$transaction(async (tx) => {
        const record = await tx.invoiceReturn.findFirst({
            where: { id: returnId },
            include: {
                items: true,
                invoice: {
                    select: { id: true, invoiceNumber: true, status: true, userId: true, customerId: true },
                },
            },
        });
        if (!record) throw ApiError.notFound('Return not found');

        const locked = await lockInvoice(tx, record.invoiceId);
        if (!locked || !SETTLEABLE_STATUSES.includes(record.invoice.status)) {
            throw ApiError.conflict(
                `The original invoice is "${record.invoice.status}", so its returns cannot be approved.`
            );
        }

        const before = await loadSettlement(tx, record.invoiceId);
        const returnValuePaisa = toPaisa(record.totalAmount);

        if (returnValuePaisa > before.unpaidPaisa) {
            throw ApiError.conflict(
                `Return value ${toAmount(returnValuePaisa).toFixed(2)} is more than the outstanding amount ${toAmount(before.unpaidPaisa).toFixed(2)}. Stock can only be returned against unpaid or credit balance. Refunds of paid amounts are not supported yet.`
            );
        }

        // Money state after this return. Udhaar (creditGiven) stays in the amount due.
        const after = computeMoneyState({
            totalPaisa: before.originalTotalPaisa,
            returnValuePaisa: before.returnValuePaisa + returnValuePaisa,
            paidPaisa: before.paidPaisa,
            appliedPaisa: before.customerCreditPaisa,
            otherCreditPaisa: before.otherCreditPaisa,
            creditGivenPaisa: before.creditGivenPaisa,
        });

        const plan = planReturnSettlement({
            returnValuePaisa,
            unpaidBeforePaisa: before.unpaidPaisa,
            unpaidAfterPaisa: after.unpaidPaisa,
        });
        if (plan.customerCreditPaisa > 0) {
            // Should be unreachable after the outstanding check.
        }

        const claim = await tx.invoiceReturn.updateMany({
            where: { id: returnId, status: { in: ['pending', 'draft'] } },
            data: { status: 'approved', approvedBy: actor.id, approvedAt: new Date(), updatedAt: new Date() },
        });
        if (claim.count === 0) {
            throw ApiError.conflict(`Return ${record.returnNumber} is "${record.status}" and cannot be approved again.`);
        }

        await revalidateReturnItems(tx, record, returnId);

        // Restock saleable lines only.
        const restock = new Map();
        for (const item of record.items) {
            if (item.disposition === 'saleable' && item.productId !== null) {
                restock.set(item.productId, (restock.get(item.productId) || 0) + item.quantity);
            }
        }
        for (const [productId, quantity] of restock) {
            await tx.product.updateMany({
                where: { id: productId, userId: record.invoice.userId },
                data: { stockQuantity: { increment: quantity } },
            });
        }
        if (restock.size > 0) {
            const products = await tx.product.findMany({
                where: { id: { in: [...restock.keys()] }, userId: record.invoice.userId },
                select: { id: true, stockQuantity: true },
            });
            const stockAfter = new Map(products.map((product) => [product.id, product.stockQuantity]));
            for (const [productId, quantity] of restock) {
                await tx.stockMovement.create({
                    data: {
                        productId,
                        returnId,
                        invoiceId: record.invoiceId,
                        movement: 'return_restock',
                        quantity,
                        stockAfter: stockAfter.get(productId) ?? 0,
                        reason: `Return ${record.returnNumber}: ${record.reason}`,
                        createdBy: actor.id,
                    },
                });
            }
        }

        // Unpaid reduction (timeline record only; the amount is in E + C).
        if (plan.unpaidReductionPaisa > 0) {
            await tx.invoiceActivity.create({
                data: {
                    invoiceId: record.invoiceId,
                    actorId: actor.id,
                    eventType: 'return_settlement',
                    description: `Return ${record.returnNumber} reduced the unpaid amount`,
                    amount: toDecimal(plan.unpaidReductionPaisa),
                },
            });
        }

        await tx.invoice.updateMany({
            where: { id: record.invoiceId },
            data: { version: { increment: 1 }, updatedAt: new Date() },
        });
        const refreshed = await refreshStatus(tx, record.invoiceId);

        await writeAudit(tx, {
            actor,
            action: 'return.approved',
            documentType: 'return',
            documentId: returnId,
            invoiceReference: record.invoice.invoiceNumber,
            before: { status: record.status, outstanding: toAmount(before.unpaidPaisa) },
            after: {
                status: 'approved',
                invoiceStatus: refreshed ? refreshed.status : before.storedStatus,
                returnValue: toAmount(returnValuePaisa),
                unpaidReduction: toAmount(returnValuePaisa),
                outstanding: toAmount(after.unpaidPaisa),
                returnCredit: 0,
            },
            amountPaisa: returnValuePaisa,
            reason: record.reason,
        });

        const fresh = await tx.invoiceReturn.findFirst({ where: { id: returnId }, include: { items: true } });
        return {
            record: { ...serializeReturn(fresh, record.invoice.invoiceNumber), credit: null },
            invoiceId: record.invoiceId,
        };
    });

    const invoice = await getInvoice(actor, outcome.invoiceId);
    return { return: outcome.record, invoice };
}
/** Rejects or cancels a pending or draft return. The document is kept for history. */
export async function cancelReturn(actor, returnId, reason, outcome = 'cancelled') {
    assertPermission(actor, outcome === 'rejected' ? 'return.approve' : 'return.cancel');

    return prisma.$transaction(async (tx) => {
        const record = await tx.invoiceReturn.findFirst({
            where: { id: returnId },
            include: { invoice: { select: { invoiceNumber: true } } },
        });
        if (!record) throw ApiError.notFound('Return not found');

        const claim = await tx.invoiceReturn.updateMany({
            where: { id: returnId, status: { in: ['pending', 'draft'] } },
            data: { status: outcome, updatedAt: new Date() },
        });
        if (claim.count === 0) {
            throw ApiError.conflict(`Return ${record.returnNumber} is "${record.status}" and can no longer be changed.`);
        }

        await writeAudit(tx, {
            actor,
            action: `return.${outcome}`,
            documentType: 'return',
            documentId: returnId,
            invoiceReference: record.invoice.invoiceNumber,
            before: { status: record.status },
            after: { status: outcome },
            amountPaisa: toPaisa(record.totalAmount),
            reason: reason ?? null,
        });

        const fresh = await tx.invoiceReturn.findFirst({ where: { id: returnId }, include: { items: true } });
        return { ...serializeReturn(fresh, record.invoice.invoiceNumber), credit: null };
    });
}

/** Kept for the existing reject endpoint. */
export async function decideReturn(actor, returnId, { approve, reason }) {
    if (approve) return approveReturn(actor, returnId);
    return cancelReturn(actor, returnId, reason, 'rejected');
}

/* ================================================================== *
 * Reads: return detail and lists
 * ================================================================== */

function serializeReturn(record, invoiceNumber) {
    if (!record) return null;
    return {
        id: record.id,
        returnNumber: record.returnNumber,
        invoiceId: record.invoiceId,
        invoiceNumber: invoiceNumber ?? record.invoice?.invoiceNumber ?? null,
        customerId: record.customerId ?? record.invoice?.customerId ?? null,
        customerName: record.invoice?.customer?.name ?? null,
        returnDate: dateOnly(record.returnDate),
        reason: record.reason,
        status: record.status,
        subtotal: toAmount(toPaisa(record.subtotal)),
        taxTotal: toAmount(toPaisa(record.taxTotal)),
        totalAmount: toAmount(toPaisa(record.totalAmount)),
        subtotalPaisa: toPaisa(record.subtotal),
        taxTotalPaisa: toPaisa(record.taxTotal),
        totalAmountPaisa: toPaisa(record.totalAmount),
        createdBy: record.createdBy ?? null,
        createdByName: record.creator?.fullName ?? null,
        approvedBy: record.approvedBy ?? null,
        approvedByName: record.approver?.fullName ?? null,
        approvedAt: record.approvedAt ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        items: (record.items || []).map((item) => ({
            id: item.id,
            invoiceItemId: item.invoiceItemId,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            disposition: item.disposition,
            unitPrice: toAmount(toPaisa(item.unitPrice)),
            taxRate: Number(item.taxRate),
            subtotal: toAmount(toPaisa(item.subtotal)),
            taxAmount: toAmount(toPaisa(item.taxAmount)),
            totalAmount: toAmount(toPaisa(item.totalAmount)),
        })),
    };
}

/** Full return detail: document, credit, ledger and history. */
export async function getReturn(actor, returnId) {
    const record = await prisma.invoiceReturn.findFirst({
        where: { id: returnId, ...visibilityScope(actor) },
        include: {
            items: true,
            invoice: {
                select: {
                    id: true,
                    invoiceNumber: true,
                    status: true,
                    customerId: true,
                    userId: true,
                    customer: {
                        select: {
                            id: true, name: true, email: true, phone: true,
                            address: true, city: true, taxNumber: true, registration: true,
                        },
                    },
                },
            },
            creator: { select: { id: true, fullName: true, email: true } },
            approver: { select: { id: true, fullName: true, email: true } },
        },
    });
    if (!record) throw ApiError.notFound('Return not found');

    const [credit, history] = await Promise.all([
        loadReturnCredit(prisma, returnId),
        prisma.auditLog.findMany({
            where: { documentType: 'return', documentId: returnId },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    return {
        ...serializeReturn(record, record.invoice.invoiceNumber),
        invoice: record.invoice,
        preparedBy: record.creator
            ? { name: record.creator.fullName, email: record.creator.email }
            : { name: null, email: null },
        credit: serializeReturnCredit(credit),
        history: history.map((row) => ({
            id: row.id,
            action: row.action,
            userName: row.userSnapshotName,
            userEmail: row.userSnapshotEmail,
            reason: row.reason,
            amount: row.amount === null ? null : Number(row.amount),
            createdAt: row.createdAt,
        })),
    };
}

export async function listReturns(userId, filters = {}) {
    const { page = 1, limit = 20, search, status, customerId, invoiceNumber, from, to } = filters;
    const and = [];

    if (status) and.push({ status });
    if (customerId) and.push({ customerId });
    if (invoiceNumber) and.push({ invoice: { invoiceNumber: { contains: invoiceNumber } } });
    if (search) {
        and.push({
            OR: [
                { returnNumber: { contains: search } },
                { invoice: { invoiceNumber: { contains: search } } },
                { invoice: { customer: { name: { contains: search } } } },
            ],
        });
    }

    const where = {
        invoice: { userId },
        ...(from || to ? { returnDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(and.length ? { AND: and } : {}),
    };

    const [returns, total] = await Promise.all([
        prisma.invoiceReturn.findMany({
            where,
            include: {
                items: true,
                invoice: {
                    select: {
                        id: true, invoiceNumber: true, customerId: true,
                        customer: { select: { id: true, name: true } },
                    },
                },
                creator: { select: { fullName: true } },
            },
            orderBy: [{ returnDate: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.invoiceReturn.count({ where }),
    ]);

    const shaped = await Promise.all(
        returns.map(async (record) => ({
            ...serializeReturn(record, record.invoice.invoiceNumber),
            customerName: record.invoice.customer?.name || 'Unknown',
            credit: serializeReturnCredit(await loadReturnCredit(prisma, record.id)),
        }))
    );

    return { returns: shaped, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/* ================================================================== *
 * Document register
 * ================================================================== */

const REGISTER_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled', 'void'];

/** One register over invoices and returns, with backend-derived amounts. */
export async function documentRegister(userId, filters = {}) {
    const { page = 1, limit = 20, search, type = 'all', status, from, to } = filters;

    const returnOnly = type === 'returns' || type === 'credits' || status === 'returns' || status === 'credits';
    const invoiceOnly = (status !== undefined && REGISTER_STATUSES.includes(status)) || type === 'invoices';
    const wantsReturns = returnOnly || !invoiceOnly;
    const wantsInvoices = !returnOnly;

    const invoiceWhere = { userId };
    const returnWhere = { invoice: { userId } };

    if (search) {
        invoiceWhere.OR = [
            { invoiceNumber: { contains: search } },
            { customer: { name: { contains: search } } },
        ];
        returnWhere.OR = [
            { returnNumber: { contains: search } },
            { invoice: { invoiceNumber: { contains: search } } },
            { invoice: { customer: { name: { contains: search } } } },
        ];
    }
    if (from || to) {
        const range = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
        invoiceWhere.invoiceDate = range;
        returnWhere.returnDate = range;
    }
    if (wantsInvoices && REGISTER_STATUSES.includes(status)) invoiceWhere.status = status;
    if (wantsReturns && status === 'credits') returnWhere.status = 'approved';

    const [invoices, returns, invoiceTotal, returnTotal] = await Promise.all([
        wantsInvoices
            ? prisma.invoice.findMany({
                where: invoiceWhere,
                select: {
                    id: true, invoiceNumber: true, invoiceDate: true, status: true,
                    grandTotal: true, customerId: true, dueDate: true,
                    customer: { select: { name: true } },
                    payments: { select: { amount: true, status: true } },
                    creditNotes: { select: { appliedAmount: true, returnId: true } },
                    creditApplications: { select: { amount: true } },
                    returns: { select: { id: true, status: true, totalAmount: true } },
                    creditEntries: { select: { entryType: true, amount: true } },
                },
                orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
            })
            : Promise.resolve([]),
        wantsReturns
            ? prisma.invoiceReturn.findMany({
                where: returnWhere,
                select: {
                    id: true, returnNumber: true, returnDate: true, status: true,
                    totalAmount: true, invoiceId: true, customerId: true,
                    invoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } },
                },
                orderBy: [{ returnDate: 'desc' }, { id: 'desc' }],
            })
            : Promise.resolve([]),
        wantsInvoices ? prisma.invoice.count({ where: invoiceWhere }) : Promise.resolve(0),
        wantsReturns ? prisma.invoiceReturn.count({ where: returnWhere }) : Promise.resolve(0),
    ]);

    const rows = [
        ...invoices.map((invoice) => {
            const settlement = settlementFromRows(invoice);
            return {
                kind: 'invoice',
                id: invoice.id,
                documentNumber: invoice.invoiceNumber,
                customerId: invoice.customerId,
                customerName: invoice.customer?.name ?? 'Unknown',
                date: dateOnly(invoice.invoiceDate),
                originalAmount: toAmount(settlement.originalTotalPaisa),
                paid: toAmount(settlement.paidPaisa),
                returnCredit: toAmount(settlement.returnCreditPaisa),
                customerCredit: toAmount(settlement.customerCreditPaisa),
                outstanding: toAmount(settlement.outstandingPaisa),
                status: settlement.status,
                originalAmountPaisa: settlement.originalTotalPaisa,
                paidPaisa: settlement.paidPaisa,
                returnCreditPaisa: settlement.returnCreditPaisa,
                outstandingPaisa: settlement.outstandingPaisa,
            };
        }),
        ...returns.map((record) => ({
            kind: 'return',
            id: record.id,
            documentNumber: record.returnNumber,
            customerId: record.customerId,
            customerName: record.invoice?.customer?.name ?? 'Unknown',
            date: dateOnly(record.returnDate),
            invoiceNumber: record.invoice?.invoiceNumber ?? null,
            originalAmount: toAmount(toPaisa(record.totalAmount)),
            paid: 0,
            returnCredit: 0,
            customerCredit: 0,
            outstanding: 0,
            status: record.status,
            originalAmountPaisa: toPaisa(record.totalAmount),
            paidPaisa: 0,
            returnCreditPaisa: 0,
            outstandingPaisa: 0,
            creditAvailable: record.status === 'approved' ? toAmount(toPaisa(record.totalAmount)) : 0,
        })),
    ];

    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

    const salesRows = invoices.filter((invoice) => !['draft', 'cancelled', 'void'].includes(invoice.status));
    const salesTotalPaisa = salesRows.reduce((sum, invoice) => sum + toPaisa(invoice.grandTotal), 0);
    const paidTotalPaisa = salesRows.reduce((sum, invoice) => sum + settlementFromRows(invoice).paidPaisa, 0);
    const outstandingTotalPaisa = salesRows.reduce(
        (sum, invoice) => sum + settlementFromRows(invoice).outstandingPaisa,
        0
    );
    const returnCreditTotalPaisa = returns
        .filter((record) => record.status === 'approved')
        .reduce((sum, record) => sum + toPaisa(record.totalAmount), 0);

    const total = invoiceTotal + returnTotal;
    const start = (page - 1) * limit;

    return {
        documents: rows.slice(start, start + limit),
        summary: {
            documentCount: total,
            invoiceCount: invoiceTotal,
            returnCount: returnTotal,
            salesTotal: toAmount(salesTotalPaisa),
            paidTotal: toAmount(paidTotalPaisa),
            outstandingTotal: toAmount(outstandingTotalPaisa),
            returnCreditTotal: toAmount(returnCreditTotalPaisa),
            salesTotalPaisa,
            outstandingTotalPaisa,
            voidExcludedFromSales: invoices.filter((invoice) => invoice.status === 'void').length,
        },
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
}

export { serializeReturn };