/**
 * Invoice request validation.
 *
 * Every validator returns { errors, value }. `value` only ever contains
 * explicitly allowed fields, which is what prevents mass assignment: the
 * controllers/services never read req.body directly.
 *
 * Money, tax rates and totals are deliberately not accepted from clients.
 * Only product IDs and quantities are read; prices come from the database.
 */

const CREATE_FIELDS = new Set(['customerId', 'invoiceDate', 'dueDate', 'notes', 'items']);
const ITEM_FIELDS = new Set(['productId', 'quantity']);
const QUERY_FIELDS = new Set(['page', 'limit', 'search', 'status', 'customerId', 'from', 'to']);

const STATUSES = new Set(['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'void']);
const DRAFT_STATUS = 'draft';

const MAX_LINES = 100;
const MAX_QUANTITY = 1000000;
const MAX_NOTES_LENGTH = 2000;
const MAX_SEARCH_LENGTH = 200;
const MAX_SQL_SERVER_INT = 2147483647;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses a YYYY-MM-DD string into a UTC date, or null when it is not one. */
function validDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
const isBlank = (input) =>
    input === undefined || input === null || (typeof input === 'string' && input.trim() === '');

/**
 * Parses a strict YYYY-MM-DD calendar date into a UTC-midnight Date.
 * Building the date and comparing the parts back catches impossible dates
 * such as 2026-02-30 even though they pass the regex.
 */
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

    if (year < 1900 || year > 2999) {
        errors.push({ field, message: `${label} must be between 1900 and 2999` });
        return undefined;
    }

    return date;
}

function parsePositiveInteger(field, input, label, errors, maximum = MAX_SQL_SERVER_INT) {
    let text;

    if (typeof input === 'number') {
        if (!Number.isSafeInteger(input)) {
            errors.push({ field, message: `${label} must be a whole number` });
            return undefined;
        }
        text = String(input);
    } else if (typeof input === 'string') {
        text = input.trim();
    } else {
        errors.push({ field, message: `${label} must be a whole number` });
        return undefined;
    }

    if (!/^[1-9]\d*$/.test(text)) {
        errors.push({ field, message: `${label} must be a positive integer` });
        return undefined;
    }

    const number = Number(text);
    if (!Number.isSafeInteger(number) || number > maximum) {
        errors.push({ field, message: `${label} is outside the supported range` });
        return undefined;
    }

    return number;
}

function parseNotes(input, errors) {
    if (isBlank(input)) return null;

    if (typeof input !== 'string') {
        errors.push({ field: 'notes', message: 'Notes must be a string or null' });
        return undefined;
    }

    const notes = input.trim();
    if (notes.length > MAX_NOTES_LENGTH) {
        errors.push({ field: 'notes', message: `Notes must be at most ${MAX_NOTES_LENGTH} characters` });
        return undefined;
    }

    return notes || null;
}

/** Validates an items array and returns only { productId, quantity }. */
function parseItems(input, errors) {
    if (isBlank(input)) {
        errors.push({ field: 'items', message: 'At least one invoice item is required' });
        return [];
    }

    if (!Array.isArray(input)) {
        errors.push({ field: 'items', message: 'Items must be an array' });
        return [];
    }

    if (input.length === 0) {
        errors.push({ field: 'items', message: 'At least one invoice item is required' });
        return [];
    }

    if (input.length > MAX_LINES) {
        errors.push({ field: 'items', message: `An invoice cannot have more than ${MAX_LINES} items` });
        return [];
    }

    const items = [];

    input.forEach((raw, index) => {
        const suffix = `items[${index}]`;

        if (!isObject(raw)) {
            errors.push({ field: suffix, message: 'Each invoice item must be an object' });
            return;
        }

        for (const field of Object.keys(raw)) {
            if (!ITEM_FIELDS.has(field)) {
                errors.push({ field: `${suffix}.${field}`, message: 'Field is not supported' });
            }
        }

        let productId;
        let quantity;

        if (isBlank(raw.productId)) {
            errors.push({ field: `${suffix}.productId`, message: 'Product is required' });
        } else {
            productId = parsePositiveInteger(`${suffix}.productId`, raw.productId, 'Product ID', errors);
        }

        if (isBlank(raw.quantity)) {
            errors.push({ field: `${suffix}.quantity`, message: 'Quantity is required' });
        } else {
            quantity = parsePositiveInteger(
                `${suffix}.quantity`,
                raw.quantity,
                'Quantity',
                errors,
                MAX_QUANTITY
            );
        }

        if (productId !== undefined && quantity !== undefined) {
            items.push({ productId, quantity });
        }
    });

    return items;
}

export function validateCreateInvoice(body) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value,
        };
    }

    for (const field of Object.keys(body)) {
        if (!CREATE_FIELDS.has(field)) {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    if (isBlank(body.customerId)) {
        errors.push({ field: 'customerId', message: 'Customer is required' });
    } else {
        const customerId = parsePositiveInteger('customerId', body.customerId, 'Customer ID', errors);
        if (customerId !== undefined) value.customerId = customerId;
    }

    if (isBlank(body.invoiceDate)) {
        errors.push({ field: 'invoiceDate', message: 'Invoice date is required' });
    } else {
        const invoiceDate = parseDateOnly('invoiceDate', body.invoiceDate, 'Invoice date', errors);
        if (invoiceDate !== undefined) value.invoiceDate = invoiceDate;
    }

    if (body.dueDate === undefined || body.dueDate === null || body.dueDate === '') {
        value.dueDate = null;
    } else {
        const dueDate = parseDateOnly('dueDate', body.dueDate, 'Due date', errors);
        if (dueDate !== undefined) value.dueDate = dueDate;
    }

    if (value.invoiceDate && value.dueDate && value.dueDate < value.invoiceDate) {
        errors.push({ field: 'dueDate', message: 'Due date must be on or after the invoice date' });
    }

    value.notes = parseNotes(body.notes, errors);
    value.items = parseItems(body.items, errors);

    return { errors, value };
}

export function validateUpdateInvoice(body) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value,
        };
    }

    for (const field of Object.keys(body)) {
        if (!CREATE_FIELDS.has(field)) {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    if (Object.hasOwn(body, 'customerId')) {
        if (isBlank(body.customerId)) {
            errors.push({ field: 'customerId', message: 'Customer is required' });
        } else {
            const customerId = parsePositiveInteger('customerId', body.customerId, 'Customer ID', errors);
            if (customerId !== undefined) value.customerId = customerId;
        }
    }

    if (Object.hasOwn(body, 'invoiceDate')) {
        if (isBlank(body.invoiceDate)) {
            errors.push({ field: 'invoiceDate', message: 'Invoice date is required' });
        } else {
            const invoiceDate = parseDateOnly('invoiceDate', body.invoiceDate, 'Invoice date', errors);
            if (invoiceDate !== undefined) value.invoiceDate = invoiceDate;
        }
    }

    if (Object.hasOwn(body, 'dueDate')) {
        if (body.dueDate === null || body.dueDate === '') {
            value.dueDate = null;
        } else {
            const dueDate = parseDateOnly('dueDate', body.dueDate, 'Due date', errors);
            if (dueDate !== undefined) value.dueDate = dueDate;
        }
    }

    if (Object.hasOwn(body, 'notes')) {
        value.notes = parseNotes(body.notes, errors);
    }

    if (Object.hasOwn(body, 'items')) {
        value.items = parseItems(body.items, errors);
    }

    if (Object.keys(value).length === 0 && errors.length === 0) {
        errors.push({ field: 'body', message: 'At least one invoice field must be provided' });
    }

    return { errors, value };
}

export function validateInvoiceListQuery(query) {
    const errors = [];
    const value = {};
    const source = isObject(query) ? query : {};

    for (const field of Object.keys(source)) {
        if (!QUERY_FIELDS.has(field)) {
            errors.push({ field, message: 'Query parameter is not supported' });
        }
    }

    const parsePositiveIntegerQuery = (field, fallback, maximum = MAX_SQL_SERVER_INT) => {
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

    value.page = parsePositiveIntegerQuery('page', DEFAULT_PAGE);
    value.limit = parsePositiveIntegerQuery('limit', DEFAULT_LIMIT, MAX_LIMIT);
    if (!Number.isSafeInteger((value.page - 1) * value.limit)) {
        errors.push({ field: 'page', message: 'Page and limit result in an unsupported offset' });
    }

    if (source.search !== undefined) {
        if (typeof source.search !== 'string') {
            errors.push({ field: 'search', message: 'Must be a string' });
        } else {
            const search = source.search.trim();
            if (search.length > MAX_SEARCH_LENGTH) {
                errors.push({ field: 'search', message: `Must be at most ${MAX_SEARCH_LENGTH} characters` });
            } else if (search) {
                value.search = search;
            }
        }
    }

    if (source.status !== undefined && source.status !== null && source.status !== '') {
        if (typeof source.status !== 'string') {
            errors.push({
                field: 'status',
                message: `Must be one of: ${[...STATUSES].join(', ')}`,
            });
        } else {
            // "All" means no filter; otherwise a single status or a comma
            // separated list of them (an invoice may match several at once).
            const requested = [
                ...new Set(
                    source.status
                        .split(',')
                        .map((entry) => entry.trim().toLowerCase())
                        .filter(Boolean)
                ),
            ];
            const unknown = requested.filter((entry) => entry !== 'all' && !STATUSES.has(entry));
            if (unknown.length > 0) {
                errors.push({
                    field: 'status',
                    message: `Must be one of: ${[...STATUSES].join(', ')}`,
                });
            } else {
                const selected = requested.filter((entry) => entry !== 'all');
                if (selected.length > 0) value.status = selected;
            }
        }
    }

    if (source.customerId !== undefined) {
        const customerId = parsePositiveIntegerQuery('customerId');
        if (customerId !== undefined) value.customerId = customerId;
    }

    for (const field of ['from', 'to']) {
        if (source[field] === undefined) continue;
        const date = parseDateOnly(field, source[field], field === 'from' ? 'From date' : 'To date', errors);
        if (date !== undefined) value[field] = date;
    }

    if (value.from && value.to && value.to < value.from) {
        errors.push({ field: 'to', message: 'To date must be on or after the from date' });
    }

    return { errors, value };
}

export function validateInvoiceId(input) {
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        return { errors: [{ field: 'id', message: 'ID must be a positive integer' }], value: null };
    }

    const id = Number(input);
    if (!Number.isSafeInteger(id) || id > MAX_SQL_SERVER_INT) {
        return { errors: [{ field: 'id', message: 'ID is outside the supported range' }], value: null };
    }
    return { errors: [], value: id };
}


export function validateInvoicePayment(body) {
    const errors = [];
    const value = {};
    const allowed = new Set([
        'amount',
        'paidAmount',
        'paymentDate',
        'method',
        'reference',
        'notes',
        'creditAmount',
        'creditReason',
        'reason',
        'idempotencyKey',
        'expectedVersion',
    ]);

    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
    }
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Field is not supported' });
    }

    /** Non-negative money with at most two decimals, returned as a fixed string. */
    const parseMoney = (field, input, label) => {
        if (input === undefined || input === null || input === '') return null;
        const num = typeof input === 'string' ? (input.trim() === '' ? NaN : Number(input)) : input;
        if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
            errors.push({ field, message: `${label} must be a non-negative number` });
            return null;
        }
        if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(String(num))) {
            errors.push({ field, message: `${label} must have no more than two decimal places` });
            return null;
        }
        return num.toFixed(2);
    };

    const amount = parseMoney('amount', body.amount !== undefined ? body.amount : body.paidAmount, 'Amount');
    const creditAmount = parseMoney('creditAmount', body.creditAmount, 'Credit amount');
    value.amount = amount ?? '0.00';
    if (creditAmount !== null) value.creditAmount = creditAmount;

    const reasonInput = body.creditReason !== undefined ? body.creditReason : body.reason;
    let creditReason = null;
    if (reasonInput !== undefined && reasonInput !== null && reasonInput !== '') {
        if (typeof reasonInput !== 'string') {
            errors.push({ field: 'creditReason', message: 'Credit reason must be a string' });
        } else if (reasonInput.trim().length > 500) {
            errors.push({ field: 'creditReason', message: 'Credit reason must be at most 500 characters' });
        } else {
            creditReason = reasonInput.trim() || null;
        }
    }
    if (creditReason) value.creditReason = creditReason;

    if (Number(creditAmount ?? 0) > 0 && !creditReason) {
        errors.push({ field: 'creditReason', message: 'Reason is required when a credit amount is entered' });
    }
    if (Number(value.amount) <= 0 && Number(creditAmount ?? 0) <= 0) {
        errors.push({ field: 'amount', message: 'Enter a paid amount or a credit amount greater than zero' });
    }

    if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && body.idempotencyKey !== '') {
        const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
        // The service prefixes the invoice id, so keep the total under NVARCHAR(120).
        if (!key || key.length > 100) {
            errors.push({ field: 'idempotencyKey', message: 'Idempotency key must be 1 to 100 characters' });
        } else {
            value.idempotencyKey = key;
        }
    }

    if (body.expectedVersion !== undefined && body.expectedVersion !== null && body.expectedVersion !== '') {
        const version = typeof body.expectedVersion === 'string' ? Number(body.expectedVersion) : body.expectedVersion;
        if (!Number.isSafeInteger(version) || version < 0) {
            errors.push({ field: 'expectedVersion', message: 'Expected version must be a non-negative whole number' });
        } else {
            value.expectedVersion = version;
        }
    }

    if (body.paymentDate === undefined || body.paymentDate === null || body.paymentDate === '') {
        value.paymentDate = new Date();
    } else {
        const date = validDate(body.paymentDate);
        if (!date) errors.push({ field: 'paymentDate', message: 'Payment date must be a valid YYYY-MM-DD date' });
        else value.paymentDate = date;
    }

    const methods = new Set(['cash', 'bank_transfer', 'cheque', 'other']);
    if (body.method !== undefined && body.method !== null && body.method !== '') {
        if (typeof body.method !== 'string' || !methods.has(body.method)) {
            errors.push({ field: 'method', message: `Method must be one of: ${[...methods].join(', ')}` });
        } else {
            value.method = body.method;
        }
    }

    for (const field of ['reference', 'notes']) {
        if (body[field] === undefined || body[field] === null || body[field] === '') continue;
        const maximum = field === 'reference' ? 100 : 1000;
        if (typeof body[field] !== 'string' || body[field].trim().length > maximum) {
            errors.push({ field, message: `Must be a string of at most ${maximum} characters` });
        } else {
            value[field] = body[field].trim();
        }
    }

    return { errors, value };
}

export const INVOICE_STATUSES = Object.freeze([...STATUSES]);
export const DRAFT_INVOICE_STATUS = DRAFT_STATUS;

/**
 * Voiding requires a reason, the void date and the invoice number typed back
 * exactly, so it cannot be triggered by a stray click or a replayed request.
 */
export function validateVoidInvoice(body) {
    const errors = [];
    const value = {};
    const allowed = new Set(['reason', 'voidDate', 'confirmNumber']);

    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
    }
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Field is not supported' });
    }

    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
        errors.push({ field: 'reason', message: 'A void reason is required and must be at most 500 characters' });
    } else {
        value.reason = body.reason.trim();
    }

    if (body.voidDate === undefined || body.voidDate === null || body.voidDate === '') {
        value.voidDate = new Date();
    } else {
        const date = validDate(body.voidDate);
        if (!date) errors.push({ field: 'voidDate', message: 'Void date must be a valid YYYY-MM-DD date' });
        else value.voidDate = date;
    }

    if (typeof body.confirmNumber !== 'string' || !body.confirmNumber.trim()) {
        errors.push({ field: 'confirmNumber', message: 'Type the invoice number exactly to confirm the void' });
    } else {
        value.confirmNumber = body.confirmNumber.trim();
    }

    return { errors, value };
}
