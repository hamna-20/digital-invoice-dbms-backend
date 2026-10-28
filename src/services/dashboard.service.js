import { Prisma } from '@prisma/client';
import prisma from '../db/prisma.js';
import {
    ALL_STATUSES,
    COMPLETED_STATUSES,
    DECIMAL_ZERO,
    ISSUED_STATUS,
    PARTIALLY_PAID_STATUS,
    PAID_STATUS,
    dashboardPeriods,
    effectiveStatus,
    invoiceFinancialTotals,
    money,
    percentageChange,
    toDateOnly,
} from '../utils/reporting.js';

/**
 * Dashboard summary.
 *
 * Definitions (shared with /api/reports):
 *   - sales   : grandTotal of issued + paid invoices (drafts/cancelled excluded)
 *   - outstanding: grandTotal of issued invoices (all time)
 *   - overdue : issued invoices whose dueDate is before today
 *   - tax recorded: taxTotal on issued + paid; tax collected: taxTotal on paid
 *
 * All money maths happens in Prisma.Decimal. Only JSON output is converted.
 */

function emptyBucket() {
    return {
        count: 0,
        taxTotal: DECIMAL_ZERO,
        grandTotal: DECIMAL_ZERO,
    };
}

function statusBuckets(groups) {
    const buckets = new Map(ALL_STATUSES.map((status) => [status, emptyBucket()]));

    for (const group of groups) {
        buckets.set(group.status, {
            count: group._count?._all ?? 0,
            taxTotal: new Prisma.Decimal(group._sum?.taxTotal ?? 0),
            grandTotal: new Prisma.Decimal(group._sum?.grandTotal ?? 0),
        });
    }

    return buckets;
}

function bucket(buckets, status) {
    return buckets.get(status) || emptyBucket();
}

export async function getSummary(userId, now = new Date()) {
    const periods = dashboardPeriods(now);
    const [monthGroups, previousAggregate, yearGroups, allTimeGroups, recent, topGroups, financialInvoices] =
        await Promise.all([
            prisma.invoice.groupBy({
                by: ['status'],
                where: {
                    userId,
                    invoiceDate: { gte: periods.currentMonthStart, lt: periods.nextMonthStart },
                },
                _sum: { taxTotal: true, grandTotal: true },
                _count: { _all: true },
            }),
            prisma.invoice.aggregate({
                where: {
                    userId,
                    status: { in: COMPLETED_STATUSES },
                    invoiceDate: { gte: periods.previousMonthStart, lt: periods.currentMonthStart },
                },
                _sum: { grandTotal: true },
            }),
            prisma.invoice.groupBy({
                by: ['status'],
                where: {
                    userId,
                    invoiceDate: { gte: periods.currentYearStart, lt: periods.nextYearStart },
                },
                _sum: { taxTotal: true, grandTotal: true },
                _count: { _all: true },
            }),
            prisma.invoice.groupBy({
                by: ['status'],
                where: { userId },
                _sum: { taxTotal: true, grandTotal: true },
                _count: { _all: true },
            }),
            prisma.invoice.findMany({
                where: { userId },
                select: {
                    id: true,
                    invoiceNumber: true,
                    customerId: true,
                    invoiceDate: true,
                    dueDate: true,
                    status: true,
                    grandTotal: true,
                    customer: { select: { name: true } },
                },
                orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
                take: 5,
            }),
            prisma.invoiceItem.groupBy({
                by: ['productId'],
                where: {
                    productId: { not: null },
                    invoice: {
                        is: {
                            userId,
                            status: { in: COMPLETED_STATUSES },
                        },
                    },
                },
                _sum: { quantity: true, lineSubtotal: true, lineTax: true },
                orderBy: { _sum: { quantity: 'desc' } },
                take: 5,
            }),
            prisma.invoice.findMany({
                where: { userId, status: { in: COMPLETED_STATUSES } },
                select: {
                    invoiceDate: true,
                    dueDate: true,
                    grandTotal: true,
                    taxTotal: true,
                    payments: { where: { status: 'completed' }, select: { amount: true, status: true } },
                    creditNotes: { select: { appliedAmount: true, totalAmount: true, taxTotal: true } },
                },
            }),
        ]);

    const month = statusBuckets(monthGroups);
    const year = statusBuckets(yearGroups);
    const allTime = statusBuckets(allTimeGroups);

    const monthIssued = bucket(month, ISSUED_STATUS);
    const monthPartial = bucket(month, PARTIALLY_PAID_STATUS);
    const monthPaid = bucket(month, PAID_STATUS);
    const yearIssued = bucket(year, ISSUED_STATUS);
    const yearPartial = bucket(year, PARTIALLY_PAID_STATUS);
    const yearPaid = bucket(year, PAID_STATUS);
    const allTimeIssued = bucket(allTime, ISSUED_STATUS);
    const allTimePartial = bucket(allTime, PARTIALLY_PAID_STATUS);
    const allTimePaid = bucket(allTime, PAID_STATUS);

    const monthFinancials = invoiceFinancialTotals(financialInvoices.filter(
        (invoice) => invoice.invoiceDate >= periods.currentMonthStart && invoice.invoiceDate < periods.nextMonthStart
    ));
    const yearFinancials = invoiceFinancialTotals(financialInvoices.filter(
        (invoice) => invoice.invoiceDate >= periods.currentYearStart && invoice.invoiceDate < periods.nextYearStart
    ));
    const allTimeFinancials = invoiceFinancialTotals(financialInvoices);

    const currentMonthSales = money(monthIssued.grandTotal.add(monthPartial.grandTotal).add(monthPaid.grandTotal));
    const previousMonthSales = money(previousAggregate._sum?.grandTotal ?? 0);
    const currentYearSales = money(yearIssued.grandTotal.add(yearPartial.grandTotal).add(yearPaid.grandTotal));
    const allTimeSales = money(allTimeIssued.grandTotal.add(allTimePartial.grandTotal).add(allTimePaid.grandTotal));

    const topProductIds = topGroups.map((group) => group.productId);
    const topNameGroups =
        topProductIds.length > 0
            ? await prisma.invoiceItem.groupBy({
                  by: ['productId', 'productName', 'productCode'],
                  where: {
                      productId: { in: topProductIds },
                      invoice: {
                          is: {
                              userId,
                              status: { in: COMPLETED_STATUSES },
                          },
                      },
                  },
                  _max: { id: true },
              })
            : [];

    const latestNameByProduct = new Map();
    for (const group of topNameGroups) {
        const current = latestNameByProduct.get(group.productId);
        const itemId = group._max?.id ?? 0;
        if (!current || itemId > current.itemId) {
            latestNameByProduct.set(group.productId, {
                itemId,
                name: group.productName,
                code: group.productCode,
            });
        }
    }

    return {
        generatedAt: now.toISOString(),
        period: {
            asOf: toDateOnly(now),
            currentMonth: {
                startDate: toDateOnly(periods.currentMonthStart),
                endDate: toDateOnly(periods.currentMonthEnd),
            },
            previousMonth: {
                startDate: toDateOnly(periods.previousMonthStart),
                endDate: toDateOnly(periods.previousMonthEnd),
            },
            currentYear: {
                startDate: toDateOnly(periods.currentYearStart),
                endDate: toDateOnly(periods.currentYearEnd),
            },
        },
        sales: {
            currentMonth: currentMonthSales,
            previousMonth: previousMonthSales,
            changePercentage: percentageChange(currentMonthSales, previousMonthSales),
            currentYear: currentYearSales,
            // Extra field used by the existing dashboard card, which shows all-time sales.
            allTime: allTimeSales,
        },
        invoices: {
            currentMonth: {
                total: ALL_STATUSES.reduce((sum, status) => sum + bucket(month, status).count, 0),
                byStatus: Object.fromEntries(
                    ALL_STATUSES.map((status) => [status, bucket(month, status).count])
                ),
                paid: monthPaid.count,
                partiallyPaid: monthPartial.count,
                outstanding: monthIssued.count + monthPartial.count,
            },
        },
        tax: {
            recorded: {
                currentMonth: money(monthIssued.taxTotal.add(monthPartial.taxTotal).add(monthPaid.taxTotal)),
                currentYear: money(yearIssued.taxTotal.add(yearPartial.taxTotal).add(yearPaid.taxTotal)),
                allTime: money(allTimeIssued.taxTotal.add(allTimePartial.taxTotal).add(allTimePaid.taxTotal)),
            },
            collected: {
                currentMonth: money(monthFinancials.taxCollected),
                currentYear: money(yearFinancials.taxCollected),
                allTime: money(allTimeFinancials.taxCollected),
            },
            outstanding: {
                currentMonth: money(monthFinancials.taxOutstanding),
                currentYear: money(yearFinancials.taxOutstanding),
                allTime: money(allTimeFinancials.taxOutstanding),
            },
        },
        outstanding: {
            amount: money(allTimeFinancials.outstandingAmount),
            invoiceCount: allTimeFinancials.outstandingInvoiceCount,
            overdueAmount: money(allTimeFinancials.overdueAmount),
            overdueInvoiceCount: allTimeFinancials.overdueInvoiceCount,
        },
        recentInvoices: recent.map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            customerId: invoice.customerId,
            customerName: invoice.customer?.name || 'Unknown customer',
            invoiceDate: toDateOnly(invoice.invoiceDate),
            dueDate: toDateOnly(invoice.dueDate),
            grandTotal: money(invoice.grandTotal),
            status: effectiveStatus(invoice, now),
        })),
        topProducts: topGroups.map((group) => {
            const snapshot = latestNameByProduct.get(group.productId);
            return {
                productId: group.productId,
                name: snapshot?.name || 'Unknown product',
                code: snapshot?.code || null,
                quantitySold: group._sum?.quantity ?? 0,
                salesSubtotal: money(group._sum?.lineSubtotal ?? 0),
                taxAmount: money(group._sum?.lineTax ?? 0),
            };
        }),
    };
}
