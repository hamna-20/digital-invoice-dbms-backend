import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import {
    COMPLETED_STATUSES,
    DECIMAL_ZERO,
    ISSUED_STATUS,
    PAID_STATUS,
    effectiveStatus,
    intersectRanges,
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

    const [groups, overdue] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['status'],
            where,
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
        }),
        prisma.invoice.aggregate({
            where: {
                ...where,
                status: ISSUED_STATUS,
                dueDate: { not: null, lt: startOfUtcDay() },
            },
            _sum: { grandTotal: true, taxTotal: true },
            _count: { _all: true },
        }),
    ]);

    const byStatus = statusMap(groups);
    const issued = entryFor(byStatus, ISSUED_STATUS);
    const paid = entryFor(byStatus, PAID_STATUS);

    const totalInvoices = groups.reduce((sum, group) => sum + (group._count?._all ?? 0), 0);
    const completedCount = issued.count + paid.count;

    const salesSubtotal = addDecimal(issued.subtotal, paid.subtotal);
    const taxTotal = addDecimal(issued.taxTotal, paid.taxTotal);
    const totalSales = addDecimal(issued.grandTotal, paid.grandTotal);

    return {
        period: periodHeader(filters),
        invoiceCount: totalInvoices,
        completedInvoiceCount: completedCount,
        paidInvoiceCount: paid.count,
        unpaidInvoiceCount: issued.count,
        overdueInvoiceCount: overdue._count?._all ?? 0,
        salesSubtotal: money(salesSubtotal),
        taxTotal: money(taxTotal),
        totalSales: money(totalSales),
        paidAmount: money(paid.grandTotal),
        outstandingAmount: money(issued.grandTotal),
        overdueAmount: money(overdue._sum?.grandTotal ?? 0),
        taxCollected: money(paid.taxTotal),
        taxOutstanding: money(issued.taxTotal),
        averageInvoiceValue: completedCount > 0 ? money(totalSales.div(completedCount)) : null,
    };
}

/** Daily grouped completed sales, oldest first. */
export async function getDailySales(userId, filters = {}) {
    const groups = await prisma.invoice.groupBy({
        by: ['invoiceDate', 'status'],
        where: completedWhere(userId, filters),
        _sum: { subtotal: true, taxTotal: true, grandTotal: true },
        _count: { _all: true },
        orderBy: { invoiceDate: 'asc' },
    });

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

    const groups = await prisma.invoice.groupBy({
        by: ['invoiceDate', 'status'],
        where: completedWhere(userId, effectiveRange),
        _sum: { subtotal: true, taxTotal: true, grandTotal: true },
        _count: { _all: true },
        orderBy: { invoiceDate: 'asc' },
    });

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

    const [recordedGroups, collectedGroups, invoiceCount] = await Promise.all([
        prisma.invoiceItem.groupBy({
            by: ['taxRate'],
            where: itemWhere,
            _sum: { lineSubtotal: true, lineTax: true },
            _count: { _all: true },
        }),
        prisma.invoiceItem.groupBy({
            by: ['taxRate'],
            where: { invoice: { is: { ...completed, status: PAID_STATUS } } },
            _sum: { lineTax: true },
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

    for (const group of collectedGroups) {
        const rate = toNumber(group.taxRate);
        const row =
            rates.get(rate) || {
                taxRate: rate,
                taxableSales: DECIMAL_ZERO,
                taxRecorded: DECIMAL_ZERO,
                taxCollected: DECIMAL_ZERO,
                lineCount: 0,
            };
        row.taxCollected = row.taxCollected.add(group._sum?.lineTax ?? 0);
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

    const [groups, overdueGroups] = await Promise.all([
        prisma.invoice.groupBy({
            by: ['customerId', 'status'],
            where,
            _sum: { subtotal: true, taxTotal: true, grandTotal: true },
            _count: { _all: true },
        }),
        prisma.invoice.groupBy({
            by: ['customerId'],
            where: {
                ...where,
                status: ISSUED_STATUS,
                dueDate: { not: null, lt: startOfUtcDay() },
            },
            _sum: { grandTotal: true },
        }),
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

        if (group.status === PAID_STATUS) {
            row.paidAmount = row.paidAmount.add(group._sum?.grandTotal ?? 0);
        } else {
            row.outstandingAmount = row.outstandingAmount.add(group._sum?.grandTotal ?? 0);
        }

        customers.set(group.customerId, row);
    }

    for (const group of overdueGroups) {
        const row = customers.get(group.customerId);
        if (row) row.overdueAmount = row.overdueAmount.add(group._sum?.grandTotal ?? 0);
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
        invoices: invoices.map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: toDateOnly(invoice.invoiceDate),
            dueDate: toDateOnly(invoice.dueDate),
            customerId: invoice.customerId,
            customerName: invoice.customer?.name || 'Unknown customer',
            subtotal: money(invoice.subtotal),
            taxTotal: money(invoice.taxTotal),
            grandTotal: money(invoice.grandTotal),
            status: effectiveStatus(invoice),
            paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
        })),
        pagination: paginationHeader(total, filters.page, filters.limit),
    };
}
