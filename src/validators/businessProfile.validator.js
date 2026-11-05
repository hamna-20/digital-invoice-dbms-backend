/**
 * Business/seller profile validation.
 *
 * The seller identity is used by the internal FBR mock readiness checks, so it
 * is validated and stored server-side instead of only in browser storage.
 * Province is limited to the small list in utils/fbr.js; nothing here claims a
 * legal tax classification.
 */

import { isValidEmail, normalizeEmail } from '../utils/email.js';
import { FBR_PROVINCES } from '../utils/fbr.js';

const TEXT_LIMITS = {
    businessName: 200,
    ntn: 50,
    strn: 50,
    province: 100,
    address: 500,
    email: 320,
    phone: 50,
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (input) =>
    input === undefined || input === null || (typeof input === 'string' && input.trim() === '');

function validateBusinessProfileBody(body) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value,
        };
    }

    for (const field of Object.keys(body)) {
        if (!Object.hasOwn(TEXT_LIMITS, field)) {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    for (const field of Object.keys(TEXT_LIMITS)) {
        if (!Object.hasOwn(body, field)) continue;

        const input = body[field];
        if (isBlank(input)) {
            value[field] = null;
            continue;
        }

        if (typeof input !== 'string') {
            errors.push({ field, message: 'Must be a string or null' });
            continue;
        }

        const normalized = field === 'email' ? normalizeEmail(input) : input.trim();
        if (normalized.length > TEXT_LIMITS[field]) {
            errors.push({ field, message: `Must be at most ${TEXT_LIMITS[field]} characters` });
            continue;
        }
        if (field === 'email' && !isValidEmail(normalized)) {
            errors.push({ field, message: 'Must be a valid email address' });
            continue;
        }
        if (field === 'province' && !FBR_PROVINCES.includes(normalized)) {
            errors.push({ field, message: `Province must be one of: ${FBR_PROVINCES.join(', ')}` });
            continue;
        }

        value[field] = normalized || null;
    }

    if (Object.keys(value).length === 0 && errors.length === 0) {
        errors.push({ field: 'body', message: 'At least one business profile field must be provided' });
    }

    return { errors, value };
}

export function validateUpdateBusinessProfile(body) {
    return validateBusinessProfileBody(body);
}

export default validateUpdateBusinessProfile;
