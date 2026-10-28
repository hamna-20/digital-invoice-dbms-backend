import { Prisma } from '@prisma/client';

/**
 * Shared reporting primitives.
 *
 * Business definitions used by /api/reports and /api/dashboard:
 *   - A "completed sale" is an invoice with status issued, partially paid or paid.
 *   - Drafts, cancelled and void invoices never contribute to sales or tax totals.
 *   - paid              = outstanding is zero (payments + applied credits).
 *   - partially_paid    = something was settled, a balance remains.
 *   - issued            = outstanding, nothing settled yet (incl. "overdue").
 *   - overdue           = issued/partially paid and dueDate is before today.
 *   - cancelled         = stopped by whoever prepared it; retained, never sold.
 *   - void              = cancelled through the authorised void workflow.
 *
 * Returns and customer credit have their own status vocabularies
 * (see RETURN_STATUSES / CREDIT_STATUSES below) and are reported separately so
 * a credit is never double-counted against the invoice it came from.
 *
 * All money maths uses Prisma.Decimal. JSON numbers are produced only at the
 * edge, matching the existing invoice API.
 */

export const DRAFT_STATUS = 'draft';
export const ISSUED_STATUS = 'issued';
export const PARTIALLY_PAID_STATUS = 'partially_paid';
export const PAID_STATUS = 'paid';
export const CANCELLED_STATUS = 'cancelled';
export const VOID_STATUS = 'void';
export const OVERDUE_STATUS = 'overdue';

export const ALL_STATUSES = Object.freeze([
    DRAFT_STATUS,
    ISSUED_STATUS,
    PARTIALLY_PAID_STATUS,
    PAID_STATUS,
    CANCELLED_STATUS,
    VOID_STATUS,
]);

/** Return document lifecycle: created as pending, then decided. */
export const RETURN_STATUSES = Object.freeze(['pending', 'draft', 'approved', 'rejected', 'cancelled']);
/** How much of an approved return credit has been consumed. */
export const CREDIT_STATUSES = Object.freeze(['unsettled', 'partially_settled', 'settled']);
/** Customer credit ledger row types. */
export const CREDIT_ENTRY_TYPES = Object.freeze([
    'credit_added',
    'credit_applied',
    'reversal_added',
    'reversal_applied',
]);

export const COMPLETED_STATUSES = Object.freeze([ISSUED_STATUS, PARTIALLY_PAID_STATUS, PAID_STATUS]);
export const API_STATUS_FILTERS = Object.freeze([
    ...ALL_STATUSES,
    OVERDUE_STATUS,
]);

export const DECIMAL_ZERO = new Prisma.Decimal(0);
export const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

/** Rounds a Decimal/number to 2 decimal places, half-up. */
export function round2(value) {
    return new Prisma.Decimal(value ?? 0).toDecimalPlaces(2, ROUND_HALF_UP);
}

/** Converts a Decimal (or number) to a JS number for JSON output. */
export function toNumber(value) {
    if (value === null || value === undefined) return 0;
    return typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
}

/** Rounds and converts to a JSON number. */
export function money(value) {
    return round2(toNumber(value)).toNumber();
}

/** Adds two Decimal-ish values without floating point. */
export function add(a, b) {
    return new Prisma.Decimal(a ?? 0).add(b ?? 0);
}

/** Computes receipts and balances from persisted payments and applied credits. */
export function invoiceFinancialTotals(invoices) {
    return invoices.reduce(
        (totals, invoice) => {
            const total = new Prisma.Decimal(invoice.grandTotal);
            const payments = (invoice.payments || [])
                .filter((payment) => payment.status === 'completed')
                .reduce((sum, payment) => sum.add(payment.amount), DECIMAL_ZERO);
            const credits = (invoice.creditNotes || [])
                .reduce((sum, note) => sum.add(note.appliedAmount), DECIMAL_ZERO)
                .add(
                    (invoice.creditApplications || []).reduce(
                        (sum, application) => sum.add(application.amount),
                        DECIMAL_ZERO
                    )
                );
            const creditTaxApplied = (invoice.creditNotes || []).reduce((sum, note) => {
                if (new Prisma.Decimal(note.totalAmount).isZero()) return sum;
                return sum.add(
                    new Prisma.Decimal(note.taxTotal)
                        .mul(note.appliedAmount)
                        .div(note.totalAmount)
                );
            }, DECIMAL_ZERO);
            const outstanding = Prisma.Decimal.max(DECIMAL_ZERO, total.sub(payments).sub(credits));
            const taxCollected = total.isZero()
                ? DECIMAL_ZERO
                : new Prisma.Decimal(invoice.taxTotal).mul(Prisma.Decimal.min(payments, total)).div(total);

            totals.paidAmount = totals.paidAmount.add(payments);
            totals.creditsApplied = totals.creditsApplied.add(credits);
            totals.outstandingAmount = totals.outstandingAmount.add(outstanding);
            totals.taxCollected = totals.taxCollected.add(taxCollected);
            totals.taxOutstanding = totals.taxOutstanding.add(
                Prisma.Decimal.max(DECIMAL_ZERO, new Prisma.Decimal(invoice.taxTotal).sub(taxCollected).sub(creditTaxApplied))
            );
            if (outstanding.greaterThan(0)) {
                totals.outstandingInvoiceCount += 1;
                if (invoice.dueDate && invoice.dueDate < startOfUtcDay()) {
                    totals.overdueAmount = totals.overdueAmount.add(outstanding);
                    totals.overdueInvoiceCount += 1;
                }
            }
            return totals;
        },
        {
            paidAmount: DECIMAL_ZERO,
            creditsApplied: DECIMAL_ZERO,
            outstandingAmount: DECIMAL_ZERO,
            taxCollected: DECIMAL_ZERO,
            taxOutstanding: DECIMAL_ZERO,
            outstandingInvoiceCount: 0,
            overdueAmount: DECIMAL_ZERO,
            overdueInvoiceCount: 0,
        }
    );
}

/** UTC midnight for a given instant (used for "today" comparisons). */
export function startOfUtcDay(date = new Date()) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Full UTC calendar month boundaries for the dashboard. */
export function dashboardPeriods(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    const currentMonthStart = new Date(Date.UTC(year, month, 1));
    const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));
    const previousMonthStart = new Date(Date.UTC(year, month - 1, 1));
    const currentYearStart = new Date(Date.UTC(year, 0, 1));
    const nextYearStart = new Date(Date.UTC(year + 1, 0, 1));

    return {
        year,
        month,
        currentMonthStart,
        nextMonthStart,
        previousMonthStart,
        previousMonthEnd: new Date(Date.UTC(year, month, 0)),
        currentYearStart,
        nextYearStart,
        currentMonthEnd: new Date(Date.UTC(year, month + 1, 0)),
        previousMonthDisplayStart: previousMonthStart,
        currentYearEnd: new Date(Date.UTC(year, 11, 31)),
    };
}

/** Inclusive range for a calendar year, used by the monthly report. */
export function yearRange(year) {
    return {
        startDate: new Date(Date.UTC(year, 0, 1)),
        endDate: new Date(Date.UTC(year, 11, 31)),
    };
}

/** Intersects two inclusive date ranges. Returns null when they do not overlap. */
export function intersectRanges(a, b) {
    const startDate =
        a.startDate && b.startDate
            ? a.startDate > b.startDate
                ? a.startDate
                : b.startDate
            : a.startDate || b.startDate || null;
    const endDate =
        a.endDate && b.endDate
            ? a.endDate < b.endDate
                ? a.endDate
                : b.endDate
            : a.endDate || b.endDate || null;

    if (startDate && endDate && startDate > endDate) return null;
    return { startDate, endDate };
}

/** Builds a Prisma invoiceDate filter from inclusive dates. */
export function invoiceDateFilter({ startDate, endDate } = {}) {
    if (!startDate && !endDate) return undefined;
    return {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {}),
    };
}

/** Serialises a Date/date-string as YYYY-MM-DD. */
export function toDateOnly(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

export function toMonthKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().slice(0, 7);
}

/**
 * API status, including the derived "overdue" value.
 * Overdue is derived for any invoice with an outstanding stored status.
 */
export function effectiveStatus(invoice, now = new Date()) {
    if ([ISSUED_STATUS, PARTIALLY_PAID_STATUS].includes(invoice.status) && invoice.dueDate) {
        const dueDate = invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate);
        if (!Number.isNaN(dueDate.getTime()) && dueDate.getTime() < startOfUtcDay(now).getTime()) {
            return OVERDUE_STATUS;
        }
    }
    return invoice.status;
}

/**
 * Percentage change from previous to current, rounded to 2dp.
 * Returns null when the previous value is zero (comparison is meaningless).
 */
export function percentageChange(current, previous) {
    const previousValue = new Prisma.Decimal(previous ?? 0);
    if (previousValue.isZero()) return null;
    return new Prisma.Decimal(current ?? 0)
        .sub(previousValue)
        .div(previousValue)
        .mul(100)
        .toDecimalPlaces(2, ROUND_HALF_UP)
        .toNumber();
}
