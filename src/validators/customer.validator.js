import { isValidEmail, normalizeEmail } from '../utils/email.js';

const CUSTOMER_FIELDS = {
    name: 200,
    email: 320,
    phone: 50,
    companyName: 200,
    taxNumber: 100,
    registration: 30,
    address: 500,
    city: 100,
    notes: 4000,
};
const OPTIONAL_FIELDS = Object.keys(CUSTOMER_FIELDS).filter((field) => field !== 'name');
const QUERY_FIELDS = new Set(['page', 'limit', 'search', 'city']);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;
const MAX_SQL_SERVER_INT = 2147483647;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateCustomerBody(body, partial) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value,
        };
    }

    for (const field of Object.keys(body)) {
        if (!Object.hasOwn(CUSTOMER_FIELDS, field)) {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    if (!partial || Object.hasOwn(body, 'name')) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
            errors.push({ field: 'name', message: 'Name is required and must not be empty' });
        } else {
            const name = body.name.trim().replace(/\s+/g, ' ');
            if (name.length > CUSTOMER_FIELDS.name) {
                errors.push({ field: 'name', message: `Name must be at most ${CUSTOMER_FIELDS.name} characters` });
            } else {
                value.name = name;
            }
        }
    }

    for (const field of OPTIONAL_FIELDS) {
        if (partial && !Object.hasOwn(body, field)) continue;

        const input = body[field];
        if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) {
            value[field] = null;
            continue;
        }

        if (typeof input !== 'string') {
            errors.push({ field, message: 'Must be a string or null' });
            continue;
        }

        const normalized = field === 'email' ? normalizeEmail(input) : input.trim();
        if (normalized.length > CUSTOMER_FIELDS[field]) {
            errors.push({ field, message: `Must be at most ${CUSTOMER_FIELDS[field]} characters` });
        } else if (field === 'email' && !isValidEmail(normalized)) {
            errors.push({ field, message: 'Must be a valid email address' });
        } else if (field === 'registration' && !['Registered', 'Unregistered'].includes(normalized)) {
            errors.push({ field, message: 'Registration must be Registered or Unregistered' });
        } else {
            value[field] = normalized || null;
        }
    }

    if (partial && Object.keys(value).length === 0 && errors.length === 0) {
        errors.push({ field: 'body', message: 'At least one customer field must be provided' });
    }

    return { errors, value };
}

export function validateCreateCustomer(body) {
    return validateCustomerBody(body, false);
}

export function validateUpdateCustomer(body) {
    return validateCustomerBody(body, true);
}

export function validateCustomerListQuery(query) {
    const errors = [];
    const value = {};
    const source = isObject(query) ? query : {};

    for (const field of Object.keys(source)) {
        if (!QUERY_FIELDS.has(field)) {
            errors.push({ field, message: 'Query parameter is not supported' });
        }
    }

    const parsePositiveInteger = (field, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
        const input = source[field];
        if (input === undefined) return fallback;
        if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
            errors.push({ field, message: 'Must be a positive integer' });
            return fallback;
        }

        const parsed = Number(input);
        if (!Number.isSafeInteger(parsed) || parsed > maximum) {
            errors.push({ field, message: `Must be no greater than ${maximum}` });
            return fallback;
        }
        return parsed;
    };

    value.page = parsePositiveInteger('page', DEFAULT_PAGE);
    value.limit = parsePositiveInteger('limit', DEFAULT_LIMIT, MAX_LIMIT);
    if (!Number.isSafeInteger((value.page - 1) * value.limit)) {
        errors.push({ field: 'page', message: 'Page and limit result in an unsupported offset' });
    }

    for (const field of ['search', 'city']) {
        const input = source[field];
        if (input === undefined) continue;
        if (typeof input !== 'string') {
            errors.push({ field, message: 'Must be a string' });
            continue;
        }

        const normalized = input.trim();
        const maximum = field === 'city' ? CUSTOMER_FIELDS.city : 200;
        if (normalized.length > maximum) {
            errors.push({ field, message: `Must be at most ${maximum} characters` });
        } else if (normalized) {
            value[field] = normalized;
        }
    }

    return { errors, value };
}

export function validateCustomerId(input) {
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        return { errors: [{ field: 'id', message: 'ID must be a positive integer' }], value: null };
    }

    const id = Number(input);
    if (!Number.isSafeInteger(id) || id > MAX_SQL_SERVER_INT) {
        return { errors: [{ field: 'id', message: 'ID is outside the supported range' }], value: null };
    }
    return { errors: [], value: id };
}
