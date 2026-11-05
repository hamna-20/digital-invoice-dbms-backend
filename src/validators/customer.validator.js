import { isValidEmail, normalizeEmail } from '../utils/email.js';
import { FBR_PROVINCES } from '../utils/fbr.js';

const CUSTOMER_FIELDS = {
    name: 200,
    email: 320,
    phone: 50,
    companyName: 200,
    taxNumber: 100,
    strn: 50,
    registration: 30,
    customerType: 30,
    filerStatus: 30,
    taxExemptionDetails: 500,
    bankName: 100,
    bankBranch: 100,
    accountTitle: 200,
    accountNumber: 60,
    province: 100,
    address: 500,
    city: 100,
    notes: 4000,
};
const OPTIONAL_FIELDS = Object.keys(CUSTOMER_FIELDS).filter((field) => field !== 'name');
const QUERY_FIELDS = new Set(['page', 'limit', 'search', 'city']);

/**
 * FBR buyer classification. A single integer drives the legacy registration,
 * customer type and identifier requirements.
 */
const BUYER_TYPE_REGISTRATION = {
    1: 'End User',
    2: 'Registered',
    3: 'Unregistered',
    4: 'Foreign',
};
const BUYER_TYPES = new Set(Object.keys(BUYER_TYPE_REGISTRATION).map(Number));
const DERIVED_FIELDS = new Set([
    'registration',
    'customerType',
    'filerStatus',
    'taxExemptionDetails',
    'bankName',
    'bankBranch',
    'accountTitle',
    'accountNumber',
]);
const CNIC_PATTERN = /^\d{5}-\d{7}-\d$|^\d{13}$/;
const NTN_PATTERN = /^\d{7}-\d$|^\d{7,8}$/;
const STRN_PATTERN = /^\d{13}$/;
const FOREIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/-]{2,99}$/;
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
        if (!Object.hasOwn(CUSTOMER_FIELDS, field) && field !== 'buyerType') {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    let buyerType = null;
    if (Object.hasOwn(body, 'buyerType') && body.buyerType !== undefined && body.buyerType !== null) {
        if (!Number.isInteger(body.buyerType) || !BUYER_TYPES.has(body.buyerType)) {
            errors.push({ field: 'buyerType', message: 'Buyer type must be 1, 2, 3 or 4' });
        } else {
            buyerType = body.buyerType;
            value.buyerType = buyerType;
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
        // buyerType is authoritative for these fields; never let an old client
        // send a conflicting manual classification.
        if (buyerType !== null && DERIVED_FIELDS.has(field)) continue;

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
        } else if (field === 'registration' && !['Registered', 'Unregistered', 'End User', 'Foreign', 'Exempted'].includes(normalized)) {
            errors.push({ field, message: 'Registration must be Registered, Unregistered, End User, Foreign or Exempted' });
        } else if (field === 'customerType' && !['Business', 'Individual'].includes(normalized)) {
            errors.push({ field, message: 'Customer type must be Business or Individual' });
        } else if (field === 'filerStatus' && !['Filer', 'Non-Filer'].includes(normalized)) {
            errors.push({ field, message: 'Filer status must be Filer or Non-Filer' });
        } else if (field === 'province' && !FBR_PROVINCES.includes(normalized)) {
            errors.push({ field, message: `Province must be one of: ${FBR_PROVINCES.join(', ')}` });
        } else {
            value[field] = normalized || null;
        }
    }

    if (buyerType !== null) {
        // Derive the fields the rest of the app (FBR mapper, invoice snapshots)
        // already understands. Cash-on-delivery records never keep bank data,
        // and FBR determines filer/exemption status from the live ATL list.
        value.registration = BUYER_TYPE_REGISTRATION[buyerType];
        value.customerType = buyerType === 1 ? 'Individual' : 'Business';
        value.filerStatus = null;
        value.taxExemptionDetails = null;
        value.bankName = null;
        value.bankBranch = null;
        value.accountTitle = null;
        value.accountNumber = null;

        const identifierSupplied = Object.hasOwn(body, 'taxNumber');
        const identifier =
            identifierSupplied && typeof body.taxNumber === 'string' ? body.taxNumber.trim() : '';
        const isCreate = !partial;

        if (buyerType === 1) {
            if ((isCreate || identifierSupplied) && identifier && !CNIC_PATTERN.test(identifier)) {
                errors.push({ field: 'taxNumber', message: 'CNIC must be 13 digits, for example 35202-1234567-1' });
            }
        } else if (buyerType === 2 || buyerType === 3) {
            if ((isCreate || identifierSupplied) && !identifier) {
                errors.push({ field: 'taxNumber', message: 'NTN is required for business buyers' });
            } else if (identifier && !NTN_PATTERN.test(identifier)) {
                errors.push({ field: 'taxNumber', message: 'NTN must be 7 digits plus a check digit, for example 1234567-1' });
            }
        } else if (buyerType === 4) {
            if ((isCreate || identifierSupplied) && !identifier) {
                errors.push({ field: 'taxNumber', message: 'Passport or foreign registration number is required' });
            } else if (identifier && !FOREIGN_ID_PATTERN.test(identifier)) {
                errors.push({ field: 'taxNumber', message: 'Passport or foreign registration number is invalid' });
            }
        }

        if (buyerType === 2) {
            const strnSupplied = Object.hasOwn(body, 'strn');
            const strn = strnSupplied && typeof body.strn === 'string' ? body.strn.trim() : '';
            if ((isCreate || strnSupplied) && !strn) {
                errors.push({ field: 'strn', message: 'STRN is required for registered business buyers' });
            } else if (strn && !STRN_PATTERN.test(strn)) {
                errors.push({ field: 'strn', message: 'STRN must be exactly 13 digits' });
            }
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
