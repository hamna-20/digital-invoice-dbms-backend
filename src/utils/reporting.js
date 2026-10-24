import { Prisma } from '@prisma/client';

/**
 * Shared reporting primitives.
 *
 * Business definitions used by /api/reports and /api/dashboard:
 *   - A "completed sale" is an invoice with status issued or paid.
 *   - Drafts and cancelled invoices never contribute to sales or tax totals.
 *   - paid    = the invoice's grandTotal has been settled (all-or-nothing model).
 *   - issued  = outstanding (includes the derived "overdue" read status).
 *   - overdue = issued and dueDate is before today (UTC calendar date).
 *
 * All money maths uses Prisma.Decimal. JSON numbers are produced only at the
 * edge, matching the existing invoice API.
 */

export const DRAFT_STATUS = 'draft';
export const ISSUED_STATUS = 'issued';
export const PAID_STATUS = 'paid';
export const CANCELLED_STATUS = 'cancelled';
export const OVERDUE_STATUS = 'overdue';

export const ALL_STATUSES = Object.freeze([DRAFT_STATUS, ISSUED_STATUS, PAID_STATUS, CANCELLED_STATUS]);
export const COMPLETED_STATUSES = Object.freeze([ISSUED_STATUS, PAID_STATUS]);
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
 * The stored status stays "issued"; this only affects read/report responses.
 */
export function effectiveStatus(invoice, now = new Date()) {
    if (invoice.status === ISSUED_STATUS && invoice.dueDate) {
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
