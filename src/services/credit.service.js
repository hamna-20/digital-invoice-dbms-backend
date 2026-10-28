import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';
import { toAmount, toPaisa, ZERO_PAISA } from '../utils/money.js';
import { can } from '../utils/permissions.js';
import { writeAudit } from './audit.service.js';
import {
    customerCreditAvailablePaisa,
    customerCreditSummary,
    refreshStatus,
    serializeSettlement,
    settlementFromRows,
    settlementSelect,
    CREDIT_ENTRY_EFFECT,
} from './settlement.service.js';

/**
 * Customer credit: a per-customer balance backed only by immutable ledger rows
 * in `CustomerCreditLedger`.
 *
 *   available = Σ (signed effect of each row), see CREDIT_ENTRY_EFFECT
 *
 * There is no editable balance column. Applying credit spends it FIFO across the
 * customer's spendable grants (net of any reversal), and every consumed source
 * is recorded in `CreditApplications`, so it is always provable which credit
 * paid for which invoice. Credit can only be applied to that customer's own
 * invoices, never paid out. The customer row is locked before the balance is
 * read, so two concurrent applications serialise.
 */

/** Advance balance types the customer can spend (FIFO). Udhaar ('issued') is excluded. */
const SPENDABLE_ENTRY_TYPES = ['credit_added', 'return_credit'];

/** Entries a correction may reverse. */
const REVERSIBLE_ENTRY_TYPES = new Set(['credit_added', 'issued', 'return_credit']);

/** Invoice states that can never receive customer credit. */
const CREDIT_BLOCKED_STATUSES = new Set(['draft', 'void', 'cancelled']);

function assertPermission(actor, permission) {
    if (!can(actor.role, permission)) {
        throw ApiError.forbidden(
            `Your role "${actor.role}" is not permitted to perform this action (${permission}).`
        );
    }
}

/** Only the owning user, a manager or an admin may act on a customer. */
function assertCustomerAccess(actor, customer) {
    if (customer.userId !== actor.id && actor.role !== 'manager' && actor.role !== 'admin') {
        throw ApiError.forbidden('You are not allowed to access this customer.');
    }
}

/** Paisa to a Prisma Decimal for storage in a DECIMAL(18,2) column. */
function toMoney(paisa) {
    return new Prisma.Decimal(paisa).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Locks the customer row so concurrent credit writes serialise. */
async function lockCustomer(tx, customerId) {
    const claim = await tx.customer.updateMany({
        where: { id: customerId },
        data: { updatedAt: new Date() },
    });
    return claim.count > 0;
}

function dateOnly(value) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

/**
 * Customer credit screen: identity, derived totals and the full ledger.
 */
export async function getCustomerCredit(actor, customerId) {
    const customer = await prisma.customer.findFirst({
        where: { id: customerId },
        select: {
            id: true,
            userId: true,
            name: true,
            email: true,
            phone: true,
            registration: true,
            taxNumber: true,
        },
    });
    if (!customer) throw ApiError.notFound('Customer not found');
    assertCustomerAccess(actor, customer);

    const [summary, entries, applications] = await Promise.all([
        customerCreditSummary(prisma, customerId),
        prisma.customerCreditEntry.findMany({
            where: { customerId },
            include: {
                sourceReturn: { select: { returnNumber: true, invoice: { select: { invoiceNumber: true } } } },
                sourceInvoice: { select: { invoiceNumber: true } },
                reversesEntry: { select: { id: true, entryType: true, amount: true, reference: true } },
                creator: { select: { fullName: true, email: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.creditApplication.findMany({
            where: { customerId },
            include: { invoice: { select: { invoiceNumber: true, status: true } } },
            orderBy: { appliedAt: 'desc' },
        }),
    ]);

    const applicationsByEntry = new Map();
    for (const application of applications) {
        const list = applicationsByEntry.get(application.customerCreditEntryId) ?? [];
        list.push(application);
        applicationsByEntry.set(application.customerCreditEntryId, list);
    }

    return {
        customer: {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            registration: customer.registration,
            taxNumber: customer.taxNumber,
        },
        available: toAmount(summary.availablePaisa),
        availablePaisa: summary.availablePaisa,
        totalAdded: toAmount(summary.addedPaisa),
        totalApplied: toAmount(summary.appliedPaisa),
        totalReversed: toAmount(summary.reversedPaisa),
        ledger: entries.map((entry) => {
            const amountPaisa = toPaisa(entry.amount);
            return {
                id: entry.id,
                date: dateOnly(entry.createdAt),
                createdAt: entry.createdAt,
                entryType: entry.entryType,
                amount: toAmount(amountPaisa),
                amountPaisa,
                signedAmount: toAmount((CREDIT_ENTRY_EFFECT[entry.entryType] ?? 0) * amountPaisa),
                reference: entry.reference,
                sourceReturnNumber: entry.sourceReturn?.returnNumber ?? null,
                sourceInvoiceNumber:
                    entry.sourceInvoice?.invoiceNumber ?? entry.sourceReturn?.invoice?.invoiceNumber ?? null,
                reversesEntryId: entry.reversesEntryId,
                reverses: entry.reversesEntry,
                reason: entry.reason,
                userName: entry.creator?.fullName ?? null,
                userEmail: entry.creator?.email ?? null,
                appliedInvoices: (applicationsByEntry.get(entry.id) ?? []).map((application) => ({
                    id: application.id,
                    invoiceId: application.invoiceId,
                    invoiceNumber: application.invoice?.invoiceNumber ?? null,
                    amount: toAmount(toPaisa(application.amount)),
                    appliedAt: application.appliedAt,
                })),
            };
        }),
    };
}

/**
 * Applies available customer credit to one of the same customer's invoices.
 * FIFO across spendable grants, one `CreditApplication` per source consumed,
 * plus one `credit_applied` ledger row.
 */
export async function applyCustomerCredit(actor, customerId, { invoiceId, amount }) {
    assertPermission(actor, 'credit.apply');

    const amountPaisa = toPaisa(amount);
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) {
        throw ApiError.badRequest('Amount must be a positive value.');
    }

    return prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findFirst({
            where: { id: customerId },
            select: { id: true, userId: true },
        });
        if (!customer) throw ApiError.notFound('Customer not found');
        assertCustomerAccess(actor, customer);

        if (!(await lockCustomer(tx, customerId))) throw ApiError.notFound('Customer not found');

        const invoice = await tx.invoice.findFirst({
            where: { id: invoiceId, customerId },
            select: {
                ...settlementSelect(),
                invoiceNumber: true,
                customerId: true,
            },
        });
        if (!invoice) {
            throw ApiError.badRequest('The invoice does not belong to this customer.');
        }
        if (CREDIT_BLOCKED_STATUSES.has(invoice.status)) {
            throw ApiError.conflict(
                `An invoice with status "${invoice.status}" cannot receive customer credit.`
            );
        }

        const settlement = settlementFromRows(invoice);
        if (settlement.outstandingPaisa <= 0) {
            throw ApiError.conflict('This invoice has no unpaid amount.');
        }
        if (amountPaisa > settlement.outstandingPaisa) {
            throw ApiError.conflict(
                `Application exceeds the unpaid amount of ${toAmount(settlement.outstandingPaisa).toFixed(2)}.`
            );
        }

        const availablePaisa = await customerCreditAvailablePaisa(tx, customerId);
        if (amountPaisa > availablePaisa) {
            throw ApiError.conflict(
                `Insufficient customer credit: available ${toAmount(availablePaisa).toFixed(2)}, requested ${toAmount(amountPaisa).toFixed(2)}.`
            );
        }

        // FIFO over spendable grants. A reversal is a negative row linked by
        // reversesEntryId, so it is netted against its source here, and a
        // reversed grant can never be spent.
        const sources = await tx.customerCreditEntry.findMany({
            where: { customerId, entryType: { in: SPENDABLE_ENTRY_TYPES } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
                id: true,
                amount: true,
                reversedBy: { select: { amount: true } },
            },
        });

        const consumed = new Map();
        let remaining = amountPaisa;
        for (const source of sources) {
            if (remaining <= 0) break;

            const grantedPaisa = toPaisa(source.amount);
            if (grantedPaisa <= 0) continue;

            const reversedPaisa = source.reversedBy.reduce(
                (total, reversal) => total + toPaisa(reversal.amount),
                ZERO_PAISA
            );
            const used = await tx.creditApplication.aggregate({
                where: { customerCreditEntryId: source.id },
                _sum: { amount: true },
            });
            const freePaisa = grantedPaisa + reversedPaisa - toPaisa(used._sum.amount);
            if (freePaisa <= 0) continue;

            const take = Math.min(freePaisa, remaining);
            consumed.set(source.id, take);
            remaining -= take;
        }
        if (remaining > 0) {
            throw ApiError.conflict('Insufficient unallocated customer credit.');
        }

        for (const [entryId, taken] of consumed) {
            await tx.creditApplication.create({
                data: {
                    customerCreditEntryId: entryId,
                    customerId,
                    invoiceId,
                    amount: toMoney(taken),
                    appliedBy: actor.id,
                },
            });
        }

        await tx.customerCreditEntry.create({
            data: {
                customerId,
                sourceInvoiceId: invoiceId,
                entryType: 'credit_applied',
                amount: toMoney(amountPaisa),
                reference: invoice.invoiceNumber,
                reason: `Customer credit applied to ${invoice.invoiceNumber}`,
                createdBy: actor.id,
            },
        });

        // Money write: invalidates stale "Record payment" saves on this invoice.
        await tx.invoice.updateMany({
            where: { id: invoiceId },
            data: { version: { increment: 1 } },
        });

        const refreshed = await refreshStatus(tx, invoiceId);
        const after = await customerCreditAvailablePaisa(tx, customerId);

        await writeAudit(tx, {
            actor,
            action: 'customer_credit.applied',
            documentType: 'customer_credit',
            documentId: customerId,
            invoiceReference: invoice.invoiceNumber,
            after: {
                invoiceNumber: invoice.invoiceNumber,
                applied: toAmount(amountPaisa),
                outstanding: toAmount(refreshed.outstandingPaisa),
                remainingCredit: toAmount(after),
            },
            amountPaisa,
        });

        return {
            appliedAmount: toAmount(amountPaisa),
            appliedPaisa: amountPaisa,
            availableAfter: toAmount(after),
            availableAfterPaisa: after,
            settlement: serializeSettlement(refreshed),
        };
    });
}

/**
 * Grants customer credit directly (advance, goodwill or correction). The
 * grant is one new `credit_added` row with a mandatory reason.
 */
export async function grantCredit(actor, customerId, { amount, reason, reference }) {
    assertPermission(actor, 'credit.grant');

    const amountPaisa = toPaisa(amount);
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) {
        throw ApiError.badRequest('Amount must be a positive value.');
    }
    if (!reason || !String(reason).trim()) {
        throw ApiError.badRequest('A reason is required for customer credit.');
    }

    return prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findFirst({
            where: { id: customerId },
            select: { id: true, userId: true },
        });
        if (!customer) throw ApiError.notFound('Customer not found');
        assertCustomerAccess(actor, customer);

        if (!(await lockCustomer(tx, customerId))) throw ApiError.notFound('Customer not found');

        const created = await tx.customerCreditEntry.create({
            data: {
                customerId,
                entryType: 'credit_added',
                amount: toMoney(amountPaisa),
                reference: reference ?? null,
                reason: String(reason).trim(),
                createdBy: actor.id,
            },
        });

        const availablePaisa = await customerCreditAvailablePaisa(tx, customerId);

        await writeAudit(tx, {
            actor,
            action: 'customer_credit.granted',
            documentType: 'customer_credit',
            documentId: customerId,
            after: {
                entryId: created.id,
                amount: toAmount(amountPaisa),
                available: toAmount(availablePaisa),
            },
            amountPaisa,
            reason: String(reason).trim(),
        });

        return {
            entryId: created.id,
            customerId,
            amount: toAmount(amountPaisa),
            availableAfter: toAmount(availablePaisa),
            availableAfterPaisa: availablePaisa,
        };
    });
}

/**
 * Reverses a positive ledger row (granted, issued or return credit).
 *
 * The ledger is never edited or deleted. The correction is a new row of the
 * SAME entry type with the amount negated and `reversesEntryId` set, so the
 * invoice figures (C, return credit) and the customer balance both come out
 * right. Reversal is refused once any of the credit has been spent, because
 * the spend would then point at credit that no longer exists.
 */
export async function reverseCreditEntry(actor, entryId, { reason }) {
    assertPermission(actor, 'credit.reverse');

    if (!reason || !String(reason).trim()) {
        throw ApiError.badRequest('A reason is required to reverse credit.');
    }

    return prisma.$transaction(async (tx) => {
        const entry = await tx.customerCreditEntry.findFirst({
            where: { id: entryId },
            include: { customer: { select: { userId: true } } },
        });
        if (!entry) throw ApiError.notFound('Credit ledger entry not found');
        assertCustomerAccess(actor, { userId: entry.customer.userId });

        if (entry.reversesEntryId) {
            throw ApiError.conflict('A reversal cannot be reversed.');
        }
        if (!REVERSIBLE_ENTRY_TYPES.has(entry.entryType)) {
            throw ApiError.conflict(`Entries of type "${entry.entryType}" cannot be reversed.`);
        }

        const amountPaisa = toPaisa(entry.amount);
        if (amountPaisa <= 0) {
            throw ApiError.conflict('Only positive credit entries can be reversed.');
        }

        if (!(await lockCustomer(tx, entry.customerId))) throw ApiError.notFound('Customer not found');

        const alreadyReversed = await tx.customerCreditEntry.findFirst({
            where: { reversesEntryId: entryId },
            select: { id: true },
        });
        if (alreadyReversed) throw ApiError.conflict('This entry has already been reversed.');

        const spent = await tx.creditApplication.aggregate({
            where: { customerCreditEntryId: entryId },
            _sum: { amount: true },
        });
        if (toPaisa(spent._sum.amount) > 0) {
            throw ApiError.conflict('This credit has already been spent and can no longer be reversed.');
        }

        const created = await tx.customerCreditEntry.create({
            data: {
                customerId: entry.customerId,
                entryType: entry.entryType,
                amount: toMoney(-amountPaisa),
                sourceInvoiceId: entry.sourceInvoiceId,
                sourceReturnId: entry.sourceReturnId,
                reversesEntryId: entry.id,
                reference: entry.reference,
                reason: String(reason).trim(),
                createdBy: actor.id,
            },
        });

        // A reversed 'issued' row changes the invoice's C, so refresh its status.
        if (entry.sourceInvoiceId) {
            await tx.invoice.updateMany({
                where: { id: entry.sourceInvoiceId },
                data: { version: { increment: 1 } },
            });
            await refreshStatus(tx, entry.sourceInvoiceId);
        }

        const after = await customerCreditAvailablePaisa(tx, entry.customerId);

        await writeAudit(tx, {
            actor,
            action: 'customer_credit.reversed',
            documentType: 'customer_credit',
            documentId: entry.customerId,
            after: {
                entryType: entry.entryType,
                reversesEntryId: entry.id,
                amount: toAmount(amountPaisa),
                available: toAmount(after),
            },
            amountPaisa,
            reason: String(reason).trim(),
        });

        return {
            entryId: created.id,
            availableAfter: toAmount(after),
            availableAfterPaisa: after,
        };
    });
}