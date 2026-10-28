/**
 * Validation for /api/reports and /api/dashboard query strings.
 *
 * Every validator returns { errors, value }. Invalid filters are rejected
 * rather than silently ignored, matching the invoice list endpoint.
 *
 * Date policy: startDate/endDate are strict YYYY-MM-DD calendar dates and are
 * compared against the invoiceDate DATE column at UTC midnight. endDate is
 * inclusive.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}$/;

export const REPORT_STATUSES = new Set([
    'draft',
    'issued',
    'partially_paid',
    'overdue',
    'paid',
    'cancelled',
    'void',
]);

const MAX_SEARCH_LENGTH = 200;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseDateOnly(field, input, label, errors) {
    if (typeof input !== 'string' || !DATE_PATTERN.test(input)) {
        errors.push({ field, message: `${label} must be a date in YYYY-MM-DD format` });
        return undefined;
    }

    const [year, month, day] = input.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        errors.push({ field, message: `${label} is not a valid calendar date` });
        return undefined;
    }

    if (year < MIN_YEAR || year > MAX_YEAR) {
        errors.push({ field, message: `${label} must be between ${MIN_YEAR} and ${MAX_YEAR}` });
        return undefined;
    }

    return date;
}

function parsePage(query, errors) {
    const input = query.page;
    if (input === undefined) return DEFAULT_PAGE;
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        errors.push({ field: 'page', message: 'Page must be a positive integer' });
        return DEFAULT_PAGE;
    }
    const page = Number(input);
    if (!Number.isSafeInteger(page) || page > 2147483647) {
        errors.push({ field: 'page', message: 'Page is outside the supported range' });
        return DEFAULT_PAGE;
    }
    return page;
}

function parseLimit(query, errors) {
    const input = query.limit;
    if (input === undefined) return DEFAULT_LIMIT;
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        errors.push({ field: 'limit', message: 'Limit must be a positive integer' });
        return DEFAULT_LIMIT;
    }
    const limit = Number(input);
    if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
        errors.push({ field: 'limit', message: `Limit must be no greater than ${MAX_LIMIT}` });
        return DEFAULT_LIMIT;
    }
    return limit;
}

function parseBase(query, allowedFields, options = {}) {
    const errors = [];
    const value = {};
    const source = isObject(query) ? query : {};

    for (const field of Object.keys(source)) {
        if (!allowedFields.includes(field)) {
            errors.push({ field, message: 'Query parameter is not supported' });
        }
    }

    for (const field of ['startDate', 'endDate']) {
        if (source[field] === undefined) continue;
        const label = field === 'startDate' ? 'Start date' : 'End date';
        const date = parseDateOnly(field, source[field], label, errors);
        if (date !== undefined) value[field] = date;
    }

    if (value.startDate && value.endDate && value.endDate < value.startDate) {
        errors.push({ field: 'endDate', message: 'End date must be on or after the start date' });
    }

    if (options.pagination) {
        value.page = parsePage(source, errors);
        value.limit = parseLimit(source, errors);
        if (!Number.isSafeInteger((value.page - 1) * value.limit)) {
            errors.push({ field: 'page', message: 'Page and limit result in an unsupported offset' });
        }
    }

    if (options.search && source.search !== undefined) {
        if (typeof source.search !== 'string') {
            errors.push({ field: 'search', message: 'Search must be a string' });
        } else {
            const search = source.search.trim();
            if (search.length > MAX_SEARCH_LENGTH) {
                errors.push({
                    field: 'search',
                    message: `Search must be at most ${MAX_SEARCH_LENGTH} characters`,
                });
            } else if (search) {
                value.search = search;
            }
        }
    }

    if (options.status && source.status !== undefined) {
        if (typeof source.status !== 'string' || !REPORT_STATUSES.has(source.status)) {
            errors.push({
                field: 'status',
                message: `Status must be one of: ${[...REPORT_STATUSES].join(', ')}`,
            });
        } else {
            value.status = source.status;
        }
    }

    if (options.year && source.year !== undefined) {
        if (typeof source.year !== 'string' || !YEAR_PATTERN.test(source.year)) {
            errors.push({ field: 'year', message: 'Year must be a four-digit number' });
        } else {
            const year = Number(source.year);
            if (year < MIN_YEAR || year > MAX_YEAR) {
                errors.push({
                    field: 'year',
                    message: `Year must be between ${MIN_YEAR} and ${MAX_YEAR}`,
                });
            } else {
                value.year = year;
            }
        }
    }

    return { errors, value };
}

export function validateSummaryQuery(query) {
    return parseBase(query, ['startDate', 'endDate']);
}

export function validateDailySalesQuery(query) {
    return parseBase(query, ['startDate', 'endDate']);
}

export function validateMonthlySalesQuery(query) {
    return parseBase(query, ['startDate', 'endDate', 'year'], { year: true });
}

export function validateTaxQuery(query) {
    return parseBase(query, ['startDate', 'endDate']);
}

export function validateCustomerReportQuery(query) {
    return parseBase(query, ['startDate', 'endDate', 'page', 'limit'], { pagination: true });
}

export function validateProductReportQuery(query) {
    return parseBase(query, ['startDate', 'endDate', 'page', 'limit'], { pagination: true });
}

export function validateInvoiceHistoryQuery(query) {
    return parseBase(query, ['startDate', 'endDate', 'search', 'status', 'page', 'limit'], {
        pagination: true,
        search: true,
        status: true,
    });
}

export const REPORT_MAX_LIMIT = MAX_LIMIT;

/* ------------------------------------------------------------------ *
 * Financial status reports (returns, credits, voids, activity)
 * ------------------------------------------------------------------ */

const RETURN_REPORT_STATUSES = new Set(['pending', 'draft', 'approved', 'rejected', 'cancelled']);
const CREDIT_ENTRY_TYPES = new Set(['credit_added', 'credit_applied', 'reversal_added', 'reversal_applied']);
const DOCUMENT_TYPES = new Set([
    'invoice',
    'payment',
    'return',
    'credit_note',
    'customer_credit',
    'credit_application',
    'user',
]);

function parsePositiveInt(query, field, errors) {
    const input = query[field];
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        errors.push({ field, message: `${field} must be a positive integer` });
        return undefined;
    }
    const value = Number(input);
    if (!Number.isSafeInteger(value) || value > 2147483647) {
        errors.push({ field, message: `${field} must be a positive integer` });
        return undefined;
    }
    return value;
}

function parseChoice(query, field, choices, errors) {
    const input = query[field];
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input !== 'string' || !choices.has(input)) {
        errors.push({ field, message: `${field} must be one of: ${[...choices].join(', ')}` });
        return undefined;
    }
    return input;
}

function parseText(query, field, maxLength, errors) {
    const input = query[field];
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input !== 'string' || input.trim().length > maxLength) {
        errors.push({ field, message: `${field} must be a string of at most ${maxLength} characters` });
        return undefined;
    }
    return input.trim();
}

/**
 * Shared filters for the financial status reports: a date range plus the
 * document-specific filters each report needs. Unknown fields are rejected
 * rather than ignored so a typo cannot silently return the wrong numbers.
 */
export function validateFinancialReportQuery(query) {
    const errors = [];
    const value = { page: DEFAULT_PAGE, limit: DEFAULT_LIMIT };
    const allowed = new Set([
        'page',
        'limit',
        'startDate',
        'endDate',
        'customerId',
        'invoiceNumber',
        'returnStatus',
        'creditStatus',
        'entryType',
        'reference',
        'action',
        'documentType',
        'userId',
    ]);

    if (!isObject(query)) {
        return { errors: [{ field: 'query', message: 'Query must be an object' }], value };
    }
    for (const field of Object.keys(query)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Filter field is not supported' });
    }

    value.page = parsePage(query, errors);
    value.limit = parseLimit(query, errors);

    if (query.startDate !== undefined) {
        const date = parseDateOnly('startDate', query.startDate, 'Start date', errors);
        if (date) value.startDate = date;
    }
    if (query.endDate !== undefined) {
        const date = parseDateOnly('endDate', query.endDate, 'End date', errors);
        if (date) value.endDate = date;
    }
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
        errors.push({ field: 'endDate', message: 'End date must be on or after start date' });
    }

    const customerId = parsePositiveInt(query, 'customerId', errors);
    if (customerId) value.customerId = customerId;

    const invoiceNumber = parseText(query, 'invoiceNumber', 40, errors);
    if (invoiceNumber) value.invoiceNumber = invoiceNumber;

    const reference = parseText(query, 'reference', 100, errors);
    if (reference) value.reference = reference;

    const action = parseText(query, 'action', 60, errors);
    if (action) value.action = action;

    const userId = parsePositiveInt(query, 'userId', errors);
    if (userId) value.userId = userId;

    const returnStatus = parseChoice(query, 'returnStatus', RETURN_REPORT_STATUSES, errors);
    if (returnStatus) value.returnStatus = returnStatus;

    const entryType = parseChoice(query, 'entryType', CREDIT_ENTRY_TYPES, errors);
    if (entryType) value.entryType = entryType;

    const documentType = parseChoice(query, 'documentType', DOCUMENT_TYPES, errors);
    if (documentType) value.documentType = documentType;

    // creditStatus is validated by the caller of the status report; accept the
    // documented vocabulary here so the query string round-trips cleanly.
    const creditStatus = parseChoice(
        query,
        'creditStatus',
        new Set(['unsettled', 'partially_settled', 'settled']),
        errors
    );
    if (creditStatus) value.creditStatus = creditStatus;

    return { errors, value };
}
