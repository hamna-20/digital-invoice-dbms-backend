/**
 * Email helpers.
 *
 * The same normalisation must be applied on signup and sign-in so that
 * "  User@Example.COM " and "user@example.com" address the same account.
 */

// Pragmatic validation: one @, a dot-suffixed domain, no whitespace.
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const MAX_EMAIL_LENGTH = 320;

/**
 * Trim surrounding whitespace and lower-case the address.
 * Returns an empty string for non-string input so callers can treat it
 * uniformly as "missing".
 */
export function normalizeEmail(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
}

export function isValidEmail(value) {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
    return EMAIL_PATTERN.test(value);
}
