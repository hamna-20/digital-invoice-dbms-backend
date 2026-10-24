import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';

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
    createdAt: true,
    updatedAt: true,
    customer: { select: customerSelect },
    items: { select: itemSelect, orderBy: { id: 'asc' } },
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

/** API status, including the derived "overdue" value. */
function effectiveStatus(invoice) {
    if (invoice.status === 'issued' && invoice.dueDate) {
        const dueDate = invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate);
        if (!Number.isNaN(dueDate.getTime()) && dueDate.getTime() < startOfUtcToday().getTime()) {
            return 'overdue';
        }
    }
    return invoice.status;
}

function serializeInvoice(invoice) {
    return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId,
        customer: invoice.customer ? { ...invoice.customer } : null,
        invoiceDate: toDateOnly(invoice.invoiceDate),
        dueDate: toDateOnly(invoice.dueDate),
        status: effectiveStatus(invoice),
        subtotal: toNumber(invoice.subtotal),
        taxTotal: toNumber(invoice.taxTotal),
        grandTotal: toNumber(invoice.grandTotal),
        notes: invoice.notes,
        paidAt: invoice.paidAt,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        items: invoice.items.map((item) => ({
            ...item,
            unitPrice: toNumber(item.unitPrice),
            taxRate: toNumber(item.taxRate),
            lineSubtotal: toNumber(item.lineSubtotal),
            lineTax: toNumber(item.lineTax),
            lineTotal: toNumber(item.lineTotal),
        })),
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
        select: { status: true, dueDate: true },
    });
    if (!invoice) throw ApiError.notFound('Invoice not found');
    return effectiveStatus(invoice);
}

export async function createInvoice(userId, input) {
    await assertCustomer(userId, input.customerId);

    const productsById = await resolveProducts(userId, input.items);
    const lines = buildLines(productsById, input.items);
    const totals = sumTotals(lines);

    const invoice = await prisma.$transaction(async (tx) => {
        const invoiceNumber = await allocateInvoiceNumber(tx);

        return tx.invoice.create({
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
    });

    return serializeInvoice(invoice);
}

export async function listInvoices(userId, { page, limit, search, status, customerId, from, to }) {
    const today = startOfUtcToday();
    const and = [];

    if (status === 'overdue') {
        and.push({ status: 'issued', dueDate: { not: null, lt: today } });
    } else if (status === 'issued') {
        and.push({ status: 'issued', OR: [{ dueDate: null }, { dueDate: { gte: today } }] });
    } else if (status) {
        and.push({ status });
    }

    if (search) {
        and.push({
            OR: [
                { invoiceNumber: { contains: search } },
                { customer: { name: { contains: search } } },
            ],
        });
    }

    const where = {
        userId,
        ...(customerId ? { customerId } : {}),
        ...(from || to
            ? {
                  invoiceDate: {
                      ...(from ? { gte: from } : {}),
                      ...(to ? { lte: to } : {}),
                  },
              }
            : {}),
        ...(and.length ? { AND: and } : {}),
    };

    const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where,
            select: invoiceSelect,
            orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.invoice.count({ where }),
    ]);

    return {
        invoices: invoices.map(serializeInvoice),
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getInvoice(userId, id) {
    const invoice = await prisma.invoice.findFirst({
        where: { id, userId },
        select: invoiceSelect,
    });

    if (!invoice) throw ApiError.notFound('Invoice not found');
    return serializeInvoice(invoice);
}

export async function updateInvoice(userId, id, input) {
    const existing = await prisma.invoice.findFirst({
        where: { id, userId },
        select: { status: true, invoiceDate: true, dueDate: true },
    });

    if (!existing) throw ApiError.notFound('Invoice not found');
    if (existing.status !== 'draft') {
        throw statusConflict('edit', effectiveStatus(existing));
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
        // Conditional claim: update-vs-issue races cannot edit an issued invoice.
        const claim = await tx.invoice.updateMany({
            where: { id, userId, status: 'draft' },
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
                select: { status: true, dueDate: true },
            });
            if (!current) throw ApiError.notFound('Invoice not found');
            throw statusConflict('edit', effectiveStatus(current));
        }

        if (lines) {
            await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
            if (lines.length > 0) {
                await tx.invoiceItem.createMany({
                    data: lines.map((line) => ({ ...line, invoiceId: id })),
                });
            }
        }
    });

    return getInvoice(userId, id);
}

export async function issueInvoice(userId, id) {
    const outcome = await prisma.$transaction(async (tx) => {
        // Claim the draft first. This is the concurrency guard.
        const claim = await tx.invoice.updateMany({
            where: { id, userId, status: 'draft' },
            data: { status: 'issued', updatedAt: new Date() },
        });

        if (claim.count === 0) return { error: 'state' };

        const invoice = await tx.invoice.findFirst({
            where: { id, userId },
            select: {
                id: true,
                items: { select: { productId: true, productName: true, quantity: true } },
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
                where: { id: productId, userId, stockQuantity: { gte: quantity } },
                data: { stockQuantity: { decrement: quantity } },
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
        }

        return { ok: true };
    });

    if (outcome.error === 'state') {
        const status = await findStatus(userId, id);
        throw statusConflict('issue', status);
    }

    return getInvoice(userId, id);
}

export async function payInvoice(userId, id) {
    const result = await prisma.invoice.updateMany({
        where: { id, userId, status: 'issued' },
        data: { status: 'paid', paidAt: new Date(), updatedAt: new Date() },
    });

    if (result.count === 0) {
        const status = await findStatus(userId, id);
        throw statusConflict('mark as paid', status);
    }

    return getInvoice(userId, id);
}

export async function cancelInvoice(userId, id) {
    const outcome = await prisma.$transaction(async (tx) => {
        const invoice = await tx.invoice.findFirst({
            where: { id, userId },
            select: {
                id: true,
                status: true,
                items: { select: { productId: true, quantity: true } },
            },
        });

        if (!invoice) return { error: 'missing' };
        if (invoice.status !== 'draft' && invoice.status !== 'issued') {
            return { error: 'state', status: invoice.status };
        }

        const claim = await tx.invoice.updateMany({
            where: { id, userId, status: invoice.status },
            data: { status: 'cancelled', updatedAt: new Date() },
        });

        if (claim.count === 0) return { error: 'state', status: invoice.status };

        // Issuing decremented stock, so cancelling an issued invoice restores it.
        if (invoice.status === 'issued') {
            const demand = new Map();
            for (const item of invoice.items) {
                if (item.productId === null) continue;
                demand.set(item.productId, (demand.get(item.productId) || 0) + item.quantity);
            }

            for (const [productId, quantity] of demand) {
                await tx.product.updateMany({
                    where: { id: productId, userId },
                    data: { stockQuantity: { increment: quantity } },
                });
            }
        }

        return { ok: true };
    });

    if (outcome.error === 'missing') throw ApiError.notFound('Invoice not found');
    if (outcome.error === 'state') throw statusConflict('cancel', outcome.status);

    return getInvoice(userId, id);
}

export async function deleteInvoice(userId, id) {
    const result = await prisma.invoice.deleteMany({
        where: { id, userId, status: 'draft' },
    });

    if (result.count === 0) {
        const status = await findStatus(userId, id);
        throw statusConflict('delete', status);
    }
}
