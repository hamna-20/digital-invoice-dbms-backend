import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import {
    COMPLETED_STATUSES,
    DECIMAL_ZERO,
    ISSUED_STATUS,
    PAID_STATUS,
    PARTIALLY_PAID_STATUS,
    VOID_STATUS,
    effectiveStatus,
    intersectRanges,
    invoiceFinancialTotals,
    invoiceDateFilter,
    money,
    startOfUtcDay,
    toDateOnly,
    toMonthKey,
    toNumber,
    yearRange,
} from '../utils/reporting.js';

/**
 * Report queries.
 *
 * All aggregation happens in SQL Server through Prisma groupBy/aggregate.
 * Only grouped rows (days, months, customers, products) are merged in memory.
 * Invoice totals are never joined to invoice items in the same query, so
 * invoice totals cannot be double-counted.
 */

const zeroEntry = () => ({
    count: 0,
    subtotal: DECIMAL_ZERO,
    taxTotal: DECIMAL_ZERO,
    grandTotal: DECIMAL_ZERO,
});

const entryFor = (map, status) => map.get(status) || zeroEntry();

function invoiceWhere(userId, filters = {}) {
    const date = invoiceDateFilter(filters);
    return {
        userId,
        ...(date ? { invoiceDate: date } : {}),
    };
}

function completedWhere(userId, filters = {}) {
    return {
        ...invoiceWhere(userId, filters),
        status: { in: COMPLETED_STATUSES },
    };
}

async function getFinancialInvoices(userId, filters = {}) {
    return prisma.invoice.findMany({
        where: completedWhere(userId, filters),
        select: {
            customerId: true,
            invoiceDate: true,
            dueDate: true,
            grandTotal: true,
            taxTotal: true,
            payments: { where: { status: 'completed' }, select: { amount: true, status: true } },
            creditNotes: { select: { appliedAmount: true, totalAmount: true, taxTotal: true } },
        },
    });
}

function groupFinancialsBy(invoices, keyFor) {
    const grouped = new Map();
    for (const invoice of invoices) {
        const key = keyFor(invoice);
        const aggregate = invoiceFinancialTotals([invoice]);
        const current = grouped.get(key) || {
            paidAmount: DECIMAL_ZERO,
            outstandingAmount: DECIMAL_ZERO,
        };
        current.paidAmount = current.paidAmount.add(aggregate.paidAmount);
        current.outstandingAmount = current.outstandingAmount.add(aggregate.outstandingAmount);
        grouped.set(key, current);
    }
    return grouped;
}

function statusMap(groups) {
    const map = new Map();
    for (const group of groups) {
        map.set(group.status, {
            count: group._count?._all ?? 0,
            subtotal: new Prisma.Decimal(group._sum?.subtotal ?? 0),
            taxTotal: new Prisma.Decimal(group._sum?.taxTotal ?? 0),
            grandTotal: new Prisma.Decimal(group._sum?.grandTotal ?? 0),
        });
    }
    return map;
}

const addDecimal = (current, value) => new Prisma.Decimal(current ?? 0).add(value ?? 0);

function periodHeader(filters, extra = {}) {
    return {
        startDate: toDateOnly(filters.startDate),
        endDate: toDateOnly(filters.endDate),
        ...extra,
    };
}

function paginationHeader(total, page, limit) {
    return {
        total,
        page,
        limit,
        totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    };
}

function emptyTotals() {
    return {
        invoiceCount: 0,
        paidInvoiceCount: 0,
        unpaidInvoiceCount: 0,
        salesSubtotal: DECIMAL_ZERO,
        taxTotal: DECIMAL_ZERO,
        totalSales: DECIMAL_ZERO,
        paidAmount: DECIMAL_ZERO,
        outstandingAmount: DECIMAL_ZERO,
    };
}

function serializeTotals(totals) {
    return {
        invoiceCount: totals.invoiceCount,
        paidInvoiceCount: totals.paidInvoiceCount,
        unpaidInvoiceCount: totals.unpaidInvoiceCount,
        salesSubtotal: money(totals.salesSubtotal),
        taxTotal: money(totals.taxTotal),
        totalSales: money(totals.totalSales),
        paidAmount: money(totals.paidAmount),
        outstandingAmount: money(totals.outstandingAmount),
    };
}

/** Dashboard-style summary for a period. Drafts/cancelled are never sales. */
export async function getSummary(userId, filters = {}) {
    const where = invoiceWhere(userId, filters);

    const [groups, financialInvoices] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['status'],
            where,
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
        }),
        getFinancialInvoices(userId, filters),
    ]);

    const byStatus = statusMap(groups);
    const issued = entryFor(byStatus, ISSUED_STATUS);
    const partiallyPaid = entryFor(byStatus, PARTIALLY_PAID_STATUS);
    const paid = entryFor(byStatus, PAID_STATUS);
    const financials = invoiceFinancialTotals(financialInvoices);

    const totalInvoices = groups.reduce((sum, group) => sum + (group._count?._all ?? 0), 0);
    const completedCount = issued.count + partiallyPaid.count + paid.count;

    const salesSubtotal = addDecimal(addDecimal(issued.subtotal, partiallyPaid.subtotal), paid.subtotal);
    const taxTotal = addDecimal(addDecimal(issued.taxTotal, partiallyPaid.taxTotal), paid.taxTotal);
    const totalSales = addDecimal(addDecimal(issued.grandTotal, partiallyPaid.grandTotal), paid.grandTotal);

    return {
        period: periodHeader(filters),
        invoiceCount: totalInvoices,
        completedInvoiceCount: completedCount,
        paidInvoiceCount: paid.count,
        unpaidInvoiceCount: issued.count + partiallyPaid.count,
        overdueInvoiceCount: financials.overdueInvoiceCount,
        salesSubtotal: money(salesSubtotal),
        taxTotal: money(taxTotal),
        totalSales: money(totalSales),
        paidAmount: money(financials.paidAmount),
        outstandingAmount: money(financials.outstandingAmount),
        overdueAmount: money(financials.overdueAmount),
        taxCollected: money(financials.taxCollected),
        taxOutstanding: money(financials.taxOutstanding),
        averageInvoiceValue: completedCount > 0 ? money(totalSales.div(completedCount)) : null,
    };
}

/** Daily grouped completed sales, oldest first. */
export async function getDailySales(userId, filters = {}) {
    const [groups, financialInvoices] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['invoiceDate', 'status'],
            where: completedWhere(userId, filters),
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
            orderBy: { invoiceDate: 'asc' },
        }),
        getFinancialInvoices(userId, filters),
    ]);
    const financialsByDate = groupFinancialsBy(financialInvoices, (invoice) => toDateOnly(invoice.invoiceDate));

    const days = new Map();

    for (const group of groups) {
        const key = toDateOnly(group.invoiceDate);
        const count = group._count?._all ?? 0;
        const row =
            days.get(key) || {
                date: key,
                invoiceCount: 0,
                paidInvoiceCount: 0,
                unpaidInvoiceCount: 0,
                salesSubtotal: DECIMAL_ZERO,
                taxTotal: DECIMAL_ZERO,
                totalSales: DECIMAL_ZERO,
                paidAmount: DECIMAL_ZERO,
                outstandingAmount: DECIMAL_ZERO,
            };

        row.invoiceCount += count;
        row.salesSubtotal = row.salesSubtotal.add(group._sum?.subtotal ?? 0);
        row.taxTotal = row.taxTotal.add(group._sum?.taxTotal ?? 0);
        row.totalSales = row.totalSales.add(group._sum?.grandTotal ?? 0);

        if (group.status === PAID_STATUS) {
            row.paidInvoiceCount += count;
            row.paidAmount = row.paidAmount.add(group._sum?.grandTotal ?? 0);
        } else {
            row.unpaidInvoiceCount += count;
            row.outstandingAmount = row.outstandingAmount.add(group._sum?.grandTotal ?? 0);
        }

        days.set(key, row);
    }

    const rows = [...days.values()];
    for (const row of rows) {
        const financials = financialsByDate.get(row.date);
        row.paidAmount = financials?.paidAmount ?? DECIMAL_ZERO;
        row.outstandingAmount = financials?.outstandingAmount ?? DECIMAL_ZERO;
    }
    const totals = emptyTotals();
    for (const row of rows) {
        totals.invoiceCount += row.invoiceCount;
        totals.paidInvoiceCount += row.paidInvoiceCount;
        totals.unpaidInvoiceCount += row.unpaidInvoiceCount;
        totals.salesSubtotal = totals.salesSubtotal.add(row.salesSubtotal);
        totals.taxTotal = totals.taxTotal.add(row.taxTotal);
        totals.totalSales = totals.totalSales.add(row.totalSales);
        totals.paidAmount = totals.paidAmount.add(row.paidAmount);
        totals.outstandingAmount = totals.outstandingAmount.add(row.outstandingAmount);
    }

    return {
        period: periodHeader(filters),
        days: rows.map((row) => ({
            date: row.date,
            invoiceCount: row.invoiceCount,
            paidInvoiceCount: row.paidInvoiceCount,
            unpaidInvoiceCount: row.unpaidInvoiceCount,
            salesSubtotal: money(row.salesSubtotal),
            taxTotal: money(row.taxTotal),
            totalSales: money(row.totalSales),
            paidAmount: money(row.paidAmount),
            outstandingAmount: money(row.outstandingAmount),
        })),
        totals: serializeTotals(totals),
    };
}

/** Monthly grouped completed sales, oldest first. Year and range are intersected. */
export async function getMonthlySales(userId, filters = {}) {
    let effectiveRange = { startDate: filters.startDate, endDate: filters.endDate };

    if (filters.year) {
        const intersection = intersectRanges(effectiveRange, yearRange(filters.year));
        if (!intersection) {
            return {
                period: periodHeader(filters, { year: filters.year }),
                months: [],
                totals: serializeTotals(emptyTotals()),
            };
        }
        effectiveRange = intersection;
    }

    const [groups, financialInvoices] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['invoiceDate', 'status'],
            where: completedWhere(userId, effectiveRange),
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
            orderBy: { invoiceDate: 'asc' },
        }),
        getFinancialInvoices(userId, effectiveRange),
    ]);
    const financialsByMonth = groupFinancialsBy(financialInvoices, (invoice) => toMonthKey(invoice.invoiceDate));

    const months = new Map();

    for (const group of groups) {
        const monthKey = toMonthKey(group.invoiceDate);
        const count = group._count?._all ?? 0;
        const row =
            months.get(monthKey) || {
                year: Number(monthKey.slice(0, 4)),
                month: Number(monthKey.slice(5, 7)),
                monthKey,
                invoiceCount: 0,
                paidInvoiceCount: 0,
                unpaidInvoiceCount: 0,
                salesSubtotal: DECIMAL_ZERO,
                taxTotal: DECIMAL_ZERO,
                totalSales: DECIMAL_ZERO,
                paidAmount: DECIMAL_ZERO,
                outstandingAmount: DECIMAL_ZERO,
            };

        row.invoiceCount += count;
        row.salesSubtotal = row.salesSubtotal.add(group._sum?.subtotal ?? 0);
        row.taxTotal = row.taxTotal.add(group._sum?.taxTotal ?? 0);
        row.totalSales = row.totalSales.add(group._sum?.grandTotal ?? 0);

        if (group.status === PAID_STATUS) {
            row.paidInvoiceCount += count;
            row.paidAmount = row.paidAmount.add(group._sum?.grandTotal ?? 0);
        } else {
            row.unpaidInvoiceCount += count;
            row.outstandingAmount = row.outstandingAmount.add(group._sum?.grandTotal ?? 0);
        }

        months.set(monthKey, row);
    }

    const rows = [...months.values()];
    for (const row of rows) {
        const financials = financialsByMonth.get(row.monthKey);
        row.paidAmount = financials?.paidAmount ?? DECIMAL_ZERO;
        row.outstandingAmount = financials?.outstandingAmount ?? DECIMAL_ZERO;
    }
    const totals = emptyTotals();
    for (const row of rows) {
        totals.invoiceCount += row.invoiceCount;
        totals.paidInvoiceCount += row.paidInvoiceCount;
        totals.unpaidInvoiceCount += row.unpaidInvoiceCount;
        totals.salesSubtotal = totals.salesSubtotal.add(row.salesSubtotal);
        totals.taxTotal = totals.taxTotal.add(row.taxTotal);
        totals.totalSales = totals.totalSales.add(row.totalSales);
        totals.paidAmount = totals.paidAmount.add(row.paidAmount);
        totals.outstandingAmount = totals.outstandingAmount.add(row.outstandingAmount);
    }

    return {
        period: periodHeader({ ...filters, ...effectiveRange }, { year: filters.year ?? null }),
        months: rows.map((row) => ({
            year: row.year,
            month: row.month,
            monthKey: row.monthKey,
            invoiceCount: row.invoiceCount,
            paidInvoiceCount: row.paidInvoiceCount,
            unpaidInvoiceCount: row.unpaidInvoiceCount,
            salesSubtotal: money(row.salesSubtotal),
            taxTotal: money(row.taxTotal),
            totalSales: money(row.totalSales),
            paidAmount: money(row.paidAmount),
            outstandingAmount: money(row.outstandingAmount),
        })),
        totals: serializeTotals(totals),
    };
}

/**
 * Tax report using invoice-item snapshots (never current product rates).
 * taxRecorded = tax on completed invoices; taxCollected = tax on paid invoices.
 */
export async function getTaxReport(userId, filters = {}) {
    const completed = completedWhere(userId, filters);
    const itemWhere = { invoice: { is: completed } };

    const [recordedGroups, collectedItems, invoiceCount] = await Promise.all([
        prisma.invoiceItem.groupBy({
            by: ['taxRate'],
            where: itemWhere,
            _sum: { lineSubtotal: true, lineTax: true },
            _count: { _all: true },
        }),
        prisma.invoiceItem.findMany({
            where: { invoice: { is: completed } },
            select: {
                taxRate: true,
                lineTax: true,
                invoice: {
                    select: {
                        grandTotal: true,
                        payments: { where: { status: 'completed' }, select: { amount: true } },
                    },
                },
            },
        }),
        prisma.invoice.count({ where: completed }),
    ]);

    const rates = new Map();

    for (const group of recordedGroups) {
        const rate = toNumber(group.taxRate);
        rates.set(rate, {
            taxRate: rate,
            taxableSales: new Prisma.Decimal(group._sum?.lineSubtotal ?? 0),
            taxRecorded: new Prisma.Decimal(group._sum?.lineTax ?? 0),
            taxCollected: DECIMAL_ZERO,
            lineCount: group._count?._all ?? 0,
        });
    }

    for (const item of collectedItems) {
        const rate = toNumber(item.taxRate);
        const row =
            rates.get(rate) || {
                taxRate: rate,
                taxableSales: DECIMAL_ZERO,
                taxRecorded: DECIMAL_ZERO,
                taxCollected: DECIMAL_ZERO,
                lineCount: 0,
            };
        const grandTotal = new Prisma.Decimal(item.invoice.grandTotal);
        const received = item.invoice.payments.reduce((sum, payment) => sum.add(payment.amount), DECIMAL_ZERO);
        const ratio = grandTotal.isZero() ? DECIMAL_ZERO : Prisma.Decimal.min(received, grandTotal).div(grandTotal);
        row.taxCollected = row.taxCollected.add(new Prisma.Decimal(item.lineTax).mul(ratio));
        rates.set(rate, row);
    }

    const rows = [...rates.values()].sort((a, b) => b.taxRate - a.taxRate);
    const totals = rows.reduce(
        (acc, row) => ({
            taxableSales: acc.taxableSales.add(row.taxableSales),
            taxRecorded: acc.taxRecorded.add(row.taxRecorded),
            taxCollected: acc.taxCollected.add(row.taxCollected),
            lineCount: acc.lineCount + row.lineCount,
        }),
        { taxableSales: DECIMAL_ZERO, taxRecorded: DECIMAL_ZERO, taxCollected: DECIMAL_ZERO, lineCount: 0 }
    );

    return {
        period: periodHeader(filters),
        invoiceCount,
        lineCount: totals.lineCount,
        taxableSales: money(totals.taxableSales),
        taxRecorded: money(totals.taxRecorded),
        taxCollected: money(totals.taxCollected),
        taxOutstanding: money(totals.taxRecorded.sub(totals.taxCollected)),
        rates: rows.map((row) => ({
            taxRate: row.taxRate,
            taxableSales: money(row.taxableSales),
            taxRecorded: money(row.taxRecorded),
            taxCollected: money(row.taxCollected),
            lineCount: row.lineCount,
        })),
    };
}

/** Customer totals aggregated at invoice level, so items cannot double-count. */
export async function getCustomerReport(userId, filters = {}) {
    const where = completedWhere(userId, filters);

    const [groups, financialInvoices] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['customerId', 'status'],
            where,
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
        }),
        getFinancialInvoices(userId, filters),
    ]);

    const customers = new Map();

    for (const group of groups) {
        const count = group._count?._all ?? 0;
        const row =
            customers.get(group.customerId) || {
                customerId: group.customerId,
                invoiceCount: 0,
                salesSubtotal: DECIMAL_ZERO,
                taxTotal: DECIMAL_ZERO,
                totalInvoiced: DECIMAL_ZERO,
                paidAmount: DECIMAL_ZERO,
                outstandingAmount: DECIMAL_ZERO,
                overdueAmount: DECIMAL_ZERO,
            };

        row.invoiceCount += count;
        row.salesSubtotal = row.salesSubtotal.add(group._sum?.subtotal ?? 0);
        row.taxTotal = row.taxTotal.add(group._sum?.taxTotal ?? 0);
        row.totalInvoiced = row.totalInvoiced.add(group._sum?.grandTotal ?? 0);

        customers.set(group.customerId, row);
    }

    for (const row of customers.values()) {
        row.paidAmount = DECIMAL_ZERO;
        row.outstandingAmount = DECIMAL_ZERO;
        row.overdueAmount = DECIMAL_ZERO;
    }
    for (const invoice of financialInvoices) {
        const row = customers.get(invoice.customerId);
        if (!row) continue;
        const financials = invoiceFinancialTotals([invoice]);
        row.paidAmount = row.paidAmount.add(financials.paidAmount);
        row.outstandingAmount = row.outstandingAmount.add(financials.outstandingAmount);
        row.overdueAmount = row.overdueAmount.add(financials.overdueAmount);
    }

    const ids = [...customers.keys()];
    const names =
        ids.length > 0
            ? await prisma.customer.findMany({
                  where: { id: { in: ids }, userId },
                  select: { id: true, name: true },
              })
            : [];
    const nameById = new Map(names.map((customer) => [customer.id, customer.name]));

    const rows = [...customers.values()]
        .map((row) => ({
            ...row,
            name: nameById.get(row.customerId) || 'Unknown customer',
        }))
        .sort((a, b) => {
            const difference = b.totalInvoiced.comparedTo(a.totalInvoiced);
            return difference !== 0 ? difference : a.name.localeCompare(b.name);
        });

    const total = rows.length;
    const start = (filters.page - 1) * filters.limit;
    const pageRows = rows.slice(start, start + filters.limit);

    return {
        period: periodHeader(filters),
        customers: pageRows.map((row) => ({
            customerId: row.customerId,
            name: row.name,
            invoiceCount: row.invoiceCount,
            salesSubtotal: money(row.salesSubtotal),
            taxTotal: money(row.taxTotal),
            totalInvoiced: money(row.totalInvoiced),
            paidAmount: money(row.paidAmount),
            outstandingAmount: money(row.outstandingAmount),
            overdueAmount: money(row.overdueAmount),
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

/** Product totals from invoice-item snapshots; later product edits do not alter them. */
export async function getProductReport(userId, filters = {}) {
    const where = {
        productId: { not: null },
        invoice: { is: completedWhere(userId, filters) },
    };

    const [sumGroups, pairGroups] = await Promise.all([
        prisma.invoiceItem.groupBy({
            by: ['productId'],
            where,
            _sum: { quantity: true, lineSubtotal: true, lineTax: true },
            _count: { _all: true },
        }),
        prisma.invoiceItem.groupBy({
            by: ['productId', 'invoiceId'],
            where,
        }),
    ]);

    const invoicesByProduct = new Map();
    for (const pair of pairGroups) {
        invoicesByProduct.set(pair.productId, (invoicesByProduct.get(pair.productId) || 0) + 1);
    }

    const productIds = sumGroups.map((group) => group.productId);
    const products =
        productIds.length > 0
            ? await prisma.product.findMany({
                  where: { id: { in: productIds }, userId },
                  select: { id: true, name: true, code: true },
              })
            : [];
    const productById = new Map(products.map((product) => [product.id, product]));

    const rows = sumGroups
        .map((group) => {
            const product = productById.get(group.productId);
            return {
                productId: group.productId,
                name: product?.name || 'Unknown product',
                code: product?.code || null,
                quantitySold: group._sum?.quantity ?? 0,
                salesSubtotal: new Prisma.Decimal(group._sum?.lineSubtotal ?? 0),
                taxAmount: new Prisma.Decimal(group._sum?.lineTax ?? 0),
                invoiceCount: invoicesByProduct.get(group.productId) || 0,
            };
        })
        .sort((a, b) => {
            const difference = b.salesSubtotal.comparedTo(a.salesSubtotal);
            return difference !== 0 ? difference : a.name.localeCompare(b.name);
        });

    const total = rows.length;
    const start = (filters.page - 1) * filters.limit;
    const pageRows = rows.slice(start, start + filters.limit);

    return {
        period: periodHeader(filters),
        products: pageRows.map((row) => ({
            productId: row.productId,
            name: row.name,
            code: row.code,
            quantitySold: row.quantitySold,
            salesSubtotal: money(row.salesSubtotal),
            taxAmount: money(row.taxAmount),
            salesTotal: money(row.salesSubtotal.add(row.taxAmount)),
            invoiceCount: row.invoiceCount,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

function historyStatusWhere(status) {
    if (status === 'overdue') {
        return {
            status: ISSUED_STATUS,
            dueDate: { not: null, lt: startOfUtcDay() },
        };
    }
    if (status === ISSUED_STATUS) {
        return {
            status: ISSUED_STATUS,
            OR: [{ dueDate: null }, { dueDate: { gte: startOfUtcDay() } }],
        };
    }
    return { status };
}

/** Paginated invoice history; includes drafts/cancelled unless filtered. */
export async function getInvoiceHistory(userId, filters = {}) {
    const where = { userId };

    const date = invoiceDateFilter(filters);
    if (date) where.invoiceDate = date;

    if (filters.status) {
        Object.assign(where, historyStatusWhere(filters.status));
    }

    if (filters.search) {
        where.AND = [
            {
                OR: [
                    { invoiceNumber: { contains: filters.search } },
                    { customer: { is: { name: { contains: filters.search } } } },
                ],
            },
        ];
    }

    const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where,
            select: {
                id: true,
                invoiceNumber: true,
                customerId: true,
                invoiceDate: true,
                dueDate: true,
                status: true,
                subtotal: true,
                taxTotal: true,
                grandTotal: true,
                paidAt: true,
                customer: { select: { name: true } },
            },
            orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
            skip: (filters.page - 1) * filters.limit,
            take: filters.limit,
        }),
        prisma.invoice.count({ where }),
    ]);

    return {
        period: periodHeader(filters),
        invoices: invoices.map((invoice) => {
            const status = effectiveStatus(invoice);
            return {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                invoiceDate: toDateOnly(invoice.invoiceDate),
                dueDate: toDateOnly(invoice.dueDate),
                customerId: invoice.customerId,
                customerName: invoice.customer?.name || 'Unknown customer',
                subtotal: money(invoice.subtotal),
                taxTotal: money(invoice.taxTotal),
                grandTotal: money(invoice.grandTotal),
                status,
                // An overdue invoice is also still issued/partially paid; the
                // history table shows every tag, exactly like the invoice list.
                statuses: status === 'overdue' ? ['overdue', invoice.status] : [status],
                paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
            };
        }),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

/* ------------------------------------------------------------------ *
 * Returns, credit notes, return credits and customer credit
 *
 * These are reported separately from sales on purpose: a return credit only
 * reduces an invoice once it has actually been applied, so counting the
 * return document and the invoice it belongs to in the same total would
 * double-count the money.
 * ------------------------------------------------------------------ */

const RETURN_STATUS_LIST = ['pending', 'draft', 'approved', 'rejected', 'cancelled'];
const CREDIT_STATUS_LIST = ['unsettled', 'partially_settled', 'settled'];

function returnWhere(userId, filters = {}) {
    const where = { invoice: { userId } };
    const date = invoiceDateFilter(filters);
    if (date) where.returnDate = date;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.invoiceNumber) {
        where.invoice = { userId, invoiceNumber: { contains: filters.invoiceNumber } };
    }
    if (filters.returnStatus) where.status = filters.returnStatus;
    return where;
}

const groupByStatus = (rows, statuses) =>
    statuses.map((status) => {
        const matched = rows.filter((row) => row.status === status);
        return { status, count: matched.length };
    });

/**
 * Returns by status and every kind of credit by its own status, for the
 * chosen period. This is the single place that answers "how many returns are
 * still waiting, and how much approved credit is still unspent?".
 */
export async function getReturnsAndCreditsByStatus(userId, filters = {}) {
    const where = returnWhere(userId, filters);
    const date = invoiceDateFilter(filters);
    const noteWhere = {
        invoice: { userId },
        ...(date ? { issueDate: date } : {}),
        ...(filters.customerId ? { invoice: { userId, customerId: filters.customerId } } : {}),
    };

    const [returns, notes, credits, appliedByReturn, movedToCustomer] = await Promise.all([
        prisma.invoiceReturn.findMany({
            where,
            select: { id: true, status: true, subtotal: true, taxTotal: true, totalAmount: true },
        }),
        prisma.creditNote.findMany({
            where: noteWhere,
            select: { id: true, status: true, totalAmount: true, appliedAmount: true, returnId: true },
        }),
        prisma.returnCredit.findMany({
            where: { invoice: { userId }, ...(filters.customerId ? { customerId: filters.customerId } : {}) },
            select: { id: true, returnId: true, approvedAmount: true },
        }),
        prisma.creditNote.groupBy({
            by: ['returnId'],
            where: { returnId: { not: null } },
            _sum: { appliedAmount: true },
        }),
        prisma.customerCreditEntry.groupBy({
            by: ['sourceReturnId'],
            where: { sourceReturnId: { not: null }, entryType: 'credit_added' },
            _sum: { amount: true },
        }),
    ]);

    const sumBy = (rows, key) => {
        const map = new Map();
        for (const row of rows) {
            if (row[key] === null || row[key] === undefined) continue;
            map.set(row[key], (map.get(row[key]) ?? 0) + toNumber(row._sum.amount ?? 0));
        }
        return map;
    };
    const appliedMap = sumBy(appliedByReturn, 'returnId');
    const customerMap = sumBy(movedToCustomer, 'sourceReturnId');

    const returnsByStatus = groupByStatus(returns, RETURN_STATUS_LIST).map((entry) => {
        const matched = returns.filter((row) => row.status === entry.status);
        const subtotal = matched.reduce((sum, row) => sum.add(row.subtotal), DECIMAL_ZERO);
        const taxTotal = matched.reduce((sum, row) => sum.add(row.taxTotal), DECIMAL_ZERO);
        const totalAmount = matched.reduce((sum, row) => sum.add(row.totalAmount), DECIMAL_ZERO);
        return {
            ...entry,
            subtotal: money(subtotal),
            taxReversal: money(taxTotal),
            totalCredit: money(totalAmount),
        };
    });

    const creditNotesByStatus = ['issued', 'void'].map((status) => {
        const matched = notes.filter((row) => row.status === status);
        const total = matched.reduce((sum, row) => sum.add(row.totalAmount), DECIMAL_ZERO);
        const applied = matched.reduce((sum, row) => sum.add(row.appliedAmount), DECIMAL_ZERO);
        return {
            status,
            count: matched.length,
            totalAmount: money(total),
            appliedAmount: money(applied),
            unappliedAmount: money(total.sub(applied)),
        };
    });

    // Settlement status of each approved return credit.
    const returnCreditsByStatus = CREDIT_STATUS_LIST.map((status) => ({
        status,
        count: 0,
        approvedAmount: 0,
        allocatedAmount: 0,
        availableAmount: 0,
    }));
    for (const credit of credits) {
        const approved = toNumber(credit.approvedAmount);
        const allocated =
            (appliedMap.get(credit.returnId) ?? 0) +
            (customerMap.get(credit.returnId) ?? 0);
        const available = Math.max(0, approved - allocated);
        const key = allocated <= 0 ? 'unsettled' : available <= 0 ? 'settled' : 'partially_settled';
        const bucket = returnCreditsByStatus.find((row) => row.status === key);
        bucket.count += 1;
        bucket.approvedAmount = money(new Prisma.Decimal(bucket.approvedAmount).add(approved));
        bucket.allocatedAmount = money(new Prisma.Decimal(bucket.allocatedAmount).add(allocated));
        bucket.availableAmount = money(new Prisma.Decimal(bucket.availableAmount).add(available));
    }

    return {
        period: periodHeader(filters),
        returnsByStatus,
        creditNotesByStatus,
        returnCreditsByStatus,
        definitions: {
            returns: 'Return documents grouped by their lifecycle status.',
            creditNotes: 'Credit notes grouped by status; appliedAmount is what has reduced an invoice.',
            returnCredits:
                'Approved return credits grouped by settlement: unsettled, partially_settled or settled.',
        },
    };
}

/** Sales tax grouped by the rate it was charged at, with reversals separate. */
export async function getSalesTaxByRate(userId, filters = {}) {
    const where = invoiceWhere(userId, { ...filters, status: 'completed' });

    const [lines, returnLines] = await Promise.all([
        prisma.invoiceItem.groupBy({
            by: ['taxRate'],
            where: { invoice: where },
            _sum: { lineTax: true, lineSubtotal: true },
            _count: { _all: true },
        }),
        prisma.invoiceReturnItem.groupBy({
            by: ['taxRate'],
            where: { invoiceReturn: { invoice: { userId }, status: 'approved' } },
            _sum: { taxAmount: true, subtotal: true },
            _count: { _all: true },
        }),
    ]);

    const rates = new Set([
        ...lines.map((row) => toNumber(row.taxRate)),
        ...returnLines.map((row) => toNumber(row.taxRate)),
    ]);

    return {
        period: periodHeader(filters),
        basis: 'invoiced',
        note: 'Invoiced tax, not collected tax. Tax is only reported as invoiced; the system does not attribute tax to individual payments.',
        byRate: [...rates]
            .sort((a, b) => a - b)
            .map((rate) => {
                const invoiced = lines.find((row) => toNumber(row.taxRate) === rate);
                const reversed = returnLines.find((row) => toNumber(row.taxRate) === rate);
                const taxInvoiced = money(invoiced?._sum.lineTax ?? DECIMAL_ZERO);
                const taxReversed = money(reversed?._sum.taxAmount ?? DECIMAL_ZERO);
                return {
                    taxRate: rate,
                    invoiceLines: invoiced?._count._all ?? 0,
                    taxableAmount: money(invoiced?._sum.lineSubtotal ?? DECIMAL_ZERO),
                    taxInvoiced,
                    returnLines: reversed?._count._all ?? 0,
                    taxableAmountReturned: money(reversed?._sum.subtotal ?? DECIMAL_ZERO),
                    taxReversed,
                    netTax: money(new Prisma.Decimal(taxInvoiced).sub(taxReversed)),
                };
            }),
    };
}

/** Outstanding balances by invoice and customer, with credit shown separately. */
export async function getReceivables(userId, filters = {}) {
    const invoices = await prisma.invoice.findMany({
        where: { userId, status: { in: [ISSUED_STATUS, PARTIALLY_PAID_STATUS] } },
        select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            dueDate: true,
            grandTotal: true,
            taxTotal: true,
            customerId: true,
            customer: { select: { name: true } },
            payments: { select: { amount: true, status: true } },
            creditNotes: { select: { appliedAmount: true, returnId: true, totalAmount: true, taxTotal: true } },
            creditApplications: { select: { amount: true } },
        },
        orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
    });

    const totals = invoiceFinancialTotals(invoices);
    const today = startOfUtcDay();

    const customers = await prisma.customerCreditEntry.findMany({
        where: { customerId: { in: [...new Set(invoices.map((row) => row.customerId))] } },
        select: { customerId: true, entryType: true, amount: true },
    });
    const creditByCustomer = new Map();
    const effect = { credit_added: 1, credit_applied: -1, reversal_added: -1, reversal_applied: 1 };
    for (const row of customers) {
        const current = creditByCustomer.get(row.customerId) ?? 0;
        creditByCustomer.set(row.customerId, current + (effect[row.entryType] ?? 0) * toNumber(row.amount));
    }

    return {
        period: periodHeader(filters),
        note: 'Customer credit is listed separately and is NOT offset against receivables until it has actually been applied to an invoice.',
        totals: {
            outstandingAmount: money(totals.outstandingAmount),
            outstandingInvoiceCount: totals.outstandingInvoiceCount,
            overdueAmount: money(totals.overdueAmount),
            overdueInvoiceCount: totals.overdueInvoiceCount,
            customerCreditAvailable: money(
                [...creditByCustomer.values()].reduce((sum, value) => sum + value, 0)
            ),
        },
        invoices: invoices.map((invoice) => {
            const settled = invoiceFinancialTotals([invoice]);
            const outstanding = settled.outstandingAmount;
            const dueDate = invoice.dueDate ? toDateOnly(invoice.dueDate) : null;
            return {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                invoiceDate: toDateOnly(invoice.invoiceDate),
                dueDate,
                customerId: invoice.customerId,
                customerName: invoice.customer?.name ?? 'Unknown customer',
                grandTotal: money(invoice.grandTotal),
                amountPaid: money(settled.paidAmount),
                creditsApplied: money(settled.creditsApplied),
                outstanding: money(outstanding),
                outstandingPaisa: toNumber(outstanding) * 100,
                overdue: Boolean(dueDate && new Date(`${dueDate}T00:00:00.000Z`) < today),
            };
        }),
    };
}

/** Voided invoices with the reason and the responsible user. */
export async function getVoidedInvoices(userId, filters = {}) {
    const where = { userId, status: VOID_STATUS };
    const date = invoiceDateFilter(filters);
    if (date) where.invoiceDate = date;

    const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where,
            select: {
                id: true,
                invoiceNumber: true,
                invoiceDate: true,
                grandTotal: true,
                voidedAt: true,
                voidReason: true,
                customer: { select: { name: true } },
                voider: { select: { fullName: true, email: true } },
            },
            orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
            skip: (filters.page - 1) * filters.limit,
            take: filters.limit,
        }),
        prisma.invoice.count({ where }),
    ]);

    return {
        period: periodHeader(filters),
        note: 'Voided invoices are retained for history and are excluded from every sales and tax total.',
        voidedTotal: money(
            invoices.reduce((sum, row) => sum.add(row.grandTotal), DECIMAL_ZERO)
        ),
        invoices: invoices.map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: toDateOnly(invoice.invoiceDate),
            customerName: invoice.customer?.name ?? 'Unknown customer',
            grandTotal: money(invoice.grandTotal),
            voidedAt: invoice.voidedAt,
            voidReason: invoice.voidReason,
            voidedByName: invoice.voider?.fullName ?? null,
            voidedByEmail: invoice.voider?.email ?? null,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

/** Returns with the filters the returns report needs. */
export async function getReturnsReport(userId, filters = {}) {
    const where = returnWhere(userId, filters);

    const [returns, total] = await Promise.all([
        prisma.invoiceReturn.findMany({
            where,
            include: {
                invoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } },
                items: { select: { quantity: true, disposition: true } },
                creator: { select: { fullName: true } },
                approver: { select: { fullName: true } },
            },
            orderBy: [{ returnDate: 'desc' }, { id: 'desc' }],
            skip: (filters.page - 1) * filters.limit,
            take: filters.limit,
        }),
        prisma.invoiceReturn.count({ where }),
    ]);

    return {
        period: periodHeader(filters),
        returns: returns.map((record) => ({
            id: record.id,
            returnNumber: record.returnNumber,
            invoiceNumber: record.invoice?.invoiceNumber ?? null,
            customerName: record.invoice?.customer?.name ?? 'Unknown customer',
            returnDate: toDateOnly(record.returnDate),
            status: record.status,
            itemCount: record.items.length,
            unitsReturned: record.items.reduce((sum, item) => sum + item.quantity, 0),
            subtotal: money(record.subtotal),
            taxReversal: money(record.taxTotal),
            totalCredit: money(record.totalAmount),
            reason: record.reason,
            preparedByName: record.creator?.fullName ?? null,
            approvedByName: record.approver?.fullName ?? null,
            approvedAt: record.approvedAt,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

/** Customer credit ledger with every filter the credit report needs. */
export async function getCustomerCreditReport(userId, filters = {}) {
    const where = { customer: { userId } };
    const date = invoiceDateFilter(filters);
    if (date) where.createdAt = date;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.entryType) where.entryType = filters.entryType;
    if (filters.reference) where.reference = { contains: filters.reference };

    const [entries, total] = await Promise.all([
        prisma.customerCreditEntry.findMany({
            where,
            include: {
                customer: { select: { name: true } },
                sourceReturn: { select: { returnNumber: true } },
                creator: { select: { fullName: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (filters.page - 1) * filters.limit,
            take: filters.limit,
        }),
        prisma.customerCreditEntry.count({ where }),
    ]);

    return {
        period: periodHeader(filters),
        entries: entries.map((entry) => ({
            id: entry.id,
            customerId: entry.customerId,
            customerName: entry.customer?.name ?? 'Unknown customer',
            date: toDateOnly(entry.createdAt),
            entryType: entry.entryType,
            amount: money(entry.amount),
            signedAmount: money(
                new Prisma.Decimal(entry.amount).mul(
                    entry.entryType === 'credit_added' || entry.entryType === 'reversal_applied' ? 1 : -1
                )
            ),
            reference: entry.reference,
            sourceReturnNumber: entry.sourceReturn?.returnNumber ?? null,
            reason: entry.reason,
            userName: entry.creator?.fullName ?? null,
            createdAt: entry.createdAt,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}

/** Cross-document activity history for the audit report. */
export async function getActivityHistory(userId, filters = {}) {
    // Scoped like every other report: you see your own audit trail, unless you
    // explicitly ask for a single user's (admin drill-down).
    const where = { userId: filters.userId ?? userId };
    const date = invoiceDateFilter(filters);
    if (date) where.createdAt = date;
    if (filters.action) where.action = { contains: filters.action };
    if (filters.documentType) where.documentType = filters.documentType;

    const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (filters.page - 1) * filters.limit,
            take: filters.limit,
        }),
        prisma.auditLog.count({ where }),
    ]);

    return {
        period: periodHeader(filters),
        entries: rows.map((row) => ({
            id: row.id,
            at: row.createdAt,
            action: row.action,
            documentType: row.documentType,
            documentId: row.documentId,
            invoiceReference: row.invoiceReference,
            userId: row.userId,
            userName: row.userSnapshotName ?? 'Unknown user',
            userEmail: row.userSnapshotEmail,
            amount: row.amount === null ? null : Number(row.amount),
            reason: row.reason,
            before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
            after: row.afterJson ? JSON.parse(row.afterJson) : null,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}
