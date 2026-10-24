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

const STATUSES = new Set(['draft', 'issued', 'paid', 'overdue', 'cancelled']);
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

    if (source.status !== undefined) {
        if (typeof source.status !== 'string' || !STATUSES.has(source.status)) {
            errors.push({
                field: 'status',
                message: `Must be one of: ${[...STATUSES].join(', ')}`,
            });
        } else {
            value.status = source.status;
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

export const INVOICE_STATUSES = Object.freeze([...STATUSES]);
export const DRAFT_INVOICE_STATUS = DRAFT_STATUS;
