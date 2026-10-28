import { Prisma } from '@prisma/client';

/**
 * Money handling: the single documented policy for the whole application.
 *
 * Storage:  SQL Server DECIMAL(18,2), an exact base-10 type. Never float/real.
 * Working:  integer paisa (1 rupee = 100 paisa). Integer arithmetic in
 *           JavaScript is exact. Every amount must stay within
 *           Number.MAX_SAFE_INTEGER paisa; assertSafe() enforces this.
 * Rounding: ROUND_HALF_UP to whole paisa, applied once, when a decimal is
 *           converted to paisa. Paisa back to a decimal is exact and never rounds.
 *
 * Contract:
 *   toPaisa(x)    any decimal-like value (Decimal, string, number, null) -> integer paisa
 *   toDecimal(p)  integer paisa -> Prisma.Decimal in rupees (for persistence)
 *   toAmount(p)   integer paisa -> plain JS number in rupees (for JSON responses)
 *
 * sumPaisa / subPaisa / clampPaisa / allocatePaisa take integer paisa and
 * never convert again. Only toPaisa() reads a rupee value.
 */

const { Decimal } = Prisma;
const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;

/** 0 paisa, the neutral element for every summation. */
export const ZERO_PAISA = 0;

function assertSafe(paisa) {
    if (!Number.isSafeInteger(paisa)) {
        throw new Error(`Monetary amount out of range: ${paisa} paisa is not a safe integer.`);
    }
    return paisa;
}

/**
 * Any decimal-like value (Prisma.Decimal, numeric string, number, null) to
 * integer paisa. Negative values are supported.
 */
export function toPaisa(value) {
    if (value === null || value === undefined || value === '') return ZERO_PAISA;
    const paisa = new Decimal(value).mul(100).toDecimalPlaces(0, ROUND_HALF_UP).toNumber();
    return assertSafe(paisa);
}

/** Integer paisa to an exact Prisma.Decimal in rupees, ready to persist. */
export function toDecimal(paisa) {
    assertSafe(paisa);
    return new Decimal(paisa).div(100).toDecimalPlaces(2, ROUND_HALF_UP);
}

/** Integer paisa to a plain JS number in rupees, for JSON responses. */
export function toAmount(paisa) {
    assertSafe(paisa);
    return toDecimal(paisa).toNumber();
}

/** Sums integer paisa values. Arguments are already paisa; no conversion. */
export function sumPaisa(...values) {
    return assertSafe(values.flat().reduce((total, value) => total + assertSafe(value), ZERO_PAISA));
}

/**
 * Subtracts integer paisa values. Clamped at zero unless allowNegative is set,
 * so a balance cannot go negative through arithmetic alone.
 */
export function subPaisa(a, b, { allowNegative = false } = {}) {
    const result = assertSafe(a) - assertSafe(b);
    return assertSafe(allowNegative ? result : Math.max(ZERO_PAISA, result));
}

/** True when the amount is a positive whole number of paisa. */
export function isPositivePaisa(paisa) {
    return Number.isSafeInteger(paisa) && paisa > 0;
}

/** Clamps integer paisa to zero or above. */
export function clampPaisa(paisa) {
    return assertSafe(Math.max(ZERO_PAISA, Math.round(paisa)));
}

/** Proportional split: totalPaisa * numerator / denominator, ROUND_HALF_UP. */
export function allocatePaisa(totalPaisa, numerator, denominator) {
    assertSafe(totalPaisa);
    if (!denominator) return ZERO_PAISA;
    const share = new Decimal(totalPaisa)
        .mul(numerator)
        .div(denominator)
        .toDecimalPlaces(0, ROUND_HALF_UP)
        .toNumber();
    return assertSafe(share);
}