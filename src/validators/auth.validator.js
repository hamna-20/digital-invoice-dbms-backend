import { normalizeEmail, isValidEmail, MAX_EMAIL_LENGTH } from '../utils/email.js';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_NAME_LENGTH = 200;

/**
 * bcrypt only considers the first 72 bytes of a password, so anything longer
 * would be silently truncated. Reject it instead of surprising the user.
 */
export const MAX_PASSWORD_BYTES = 72;

const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

const asString = (value) => (typeof value === 'string' ? value : '');

/**
 * Validates and normalises a signup payload.
 * @returns {{ errors: Array<{field: string, message: string}>, value: object }}
 */
export function validateSignup(body) {
    const source = asObject(body);
    const errors = [];

    const fullName = asString(source.fullName).trim().replace(/\s+/g, ' ');
    const email = normalizeEmail(source.email);
    const password = asString(source.password);
    const confirmPassword = asString(source.confirmPassword);

    if (!asString(source.fullName).trim()) {
        errors.push({ field: 'fullName', message: 'Full name is required' });
    } else if (fullName.length > MAX_NAME_LENGTH) {
        errors.push({ field: 'fullName', message: `Full name must be at most ${MAX_NAME_LENGTH} characters` });
    }

    if (!email) {
        errors.push({ field: 'email', message: 'Email is required' });
    } else if (!isValidEmail(email)) {
        errors.push({ field: 'email', message: 'Email must be a valid email address' });
    } else if (email.length > MAX_EMAIL_LENGTH) {
        errors.push({ field: 'email', message: `Email must be at most ${MAX_EMAIL_LENGTH} characters` });
    }

    if (!password) {
        errors.push({ field: 'password', message: 'Password is required' });
    } else if (password.length < MIN_PASSWORD_LENGTH) {
        errors.push({ field: 'password', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    } else if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        errors.push({ field: 'password', message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes` });
    }

    if (!confirmPassword) {
        errors.push({ field: 'confirmPassword', message: 'Confirm password is required' });
    } else if (password !== confirmPassword) {
        errors.push({ field: 'confirmPassword', message: 'Passwords do not match' });
    }

    return { errors, value: { fullName, email, password } };
}

/**
 * Validates and normalises a sign-in payload.
 * Intentionally does not enforce the full password policy: an existing account
 * should still be able to attempt sign-in, and failures must stay generic.
 * @returns {{ errors: Array<{field: string, message: string}>, value: object }}
 */
export function validateSignin(body) {
    const source = asObject(body);
    const errors = [];

    const email = normalizeEmail(source.email);
    const password = asString(source.password);

    if (!email) {
        errors.push({ field: 'email', message: 'Email is required' });
    } else if (!isValidEmail(email)) {
        errors.push({ field: 'email', message: 'Email must be a valid email address' });
    }

    if (!password) {
        errors.push({ field: 'password', message: 'Password is required' });
    }

    return { errors, value: { email, password } };
}
