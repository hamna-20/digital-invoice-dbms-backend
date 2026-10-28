const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function positiveId(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        return null;
    }
    return value;
}

function currency(value, allowZero = false) {
    // JSON numbers and numeric strings ("275.00") are both accepted; the
    // regex keeps the value inside DECIMAL(18,2) and refuses extra precision.
    const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || (!allowZero && amount <= 0) || amount < 0) {
        return null;
    }
    if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(String(amount))) return null;
    return amount.toFixed(2);
}


export function validateCreateReturn(body) {
    const errors = [];
    const value = {};
    const allowed = new Set(['returnDate', 'reason', 'items']);
    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
    }
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Field is not supported' });
    }

    const returnDate = validDate(body.returnDate);
    if (!returnDate) errors.push({ field: 'returnDate', message: 'Return date must be a valid YYYY-MM-DD date' });
    else value.returnDate = returnDate;

    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
        errors.push({ field: 'reason', message: 'Reason is required and must be at most 500 characters' });
    } else {
        value.reason = body.reason.trim();
    }

    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
        errors.push({ field: 'items', message: 'At least one returned item is required' });
        return { errors, value };
    }

    const seen = new Set();
    const items = [];
    body.items.forEach((item, index) => {
        if (!isObject(item)) {
            errors.push({ field: `items[${index}]`, message: 'Must be an object' });
            return;
        }
        for (const field of Object.keys(item)) {
            if (!['invoiceItemId', 'quantity', 'disposition'].includes(field)) {
                errors.push({ field: `items[${index}].${field}`, message: 'Field is not supported' });
            }
        }

        const invoiceItemId = positiveId(item.invoiceItemId);
        if (!invoiceItemId) {
            errors.push({ field: `items[${index}].invoiceItemId`, message: 'Must be a valid invoice item ID' });
        } else if (seen.has(invoiceItemId)) {
            errors.push({ field: `items[${index}].invoiceItemId`, message: 'Invoice item may only appear once' });
        } else {
            seen.add(invoiceItemId);
        }

        const quantityOk = Number.isSafeInteger(item.quantity) && item.quantity >= 1;
        if (!quantityOk) {
            errors.push({ field: `items[${index}].quantity`, message: 'Quantity must be a positive integer' });
        }

        // Exact values only. Fuzzy text matching turned "non-saleable" into "saleable".
        const dispositionOk = item.disposition === 'saleable' || item.disposition === 'unsaleable';
        if (!dispositionOk) {
            errors.push({
                field: `items[${index}].disposition`,
                message: 'Disposition must be saleable or unsaleable',
            });
        }

        if (invoiceItemId && quantityOk && dispositionOk) {
            items.push({ invoiceItemId, quantity: item.quantity, disposition: item.disposition });
        }
    });
    value.items = items;

    return { errors, value };
}

export function validateReturnRejection(body) {
    if (!isObject(body) || Object.keys(body).some((field) => field !== 'reason')) {
        return { errors: [{ field: 'body', message: 'Only a reason field is supported' }], value: {} };
    }
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
        return { errors: [{ field: 'reason', message: 'Rejection reason is required and must be at most 500 characters' }], value: {} };
    }
    return { errors: [], value: { reason: body.reason.trim() } };
}

export function validateFinancialListQuery(query) {
    const errors = [];
    const value = { page: 1, limit: 20 };
    const allowed = new Set(['page', 'limit', 'search', 'status', 'customerId', 'invoiceNumber', 'from', 'to', 'applicationStatus']);

    if (query && typeof query === 'object') {
        for (const field of Object.keys(query)) {
            if (!allowed.has(field)) {
                errors.push({ field, message: 'Filter field is not supported' });
            }
        }

        if (query.page !== undefined) {
            const page = Number(query.page);
            if (!Number.isSafeInteger(page) || page < 1) {
                errors.push({ field: 'page', message: 'Page must be a positive integer' });
            } else {
                value.page = page;
            }
        }

        if (query.limit !== undefined) {
            const limit = Number(query.limit);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                errors.push({ field: 'limit', message: 'Limit must be between 1 and 100' });
            } else {
                value.limit = limit;
            }
        }

        if (query.search !== undefined && typeof query.search === 'string') {
            const trimmed = query.search.trim();
            if (trimmed) value.search = trimmed;
        }

        if (query.status !== undefined && typeof query.status === 'string') {
            const trimmed = query.status.trim();
            if (trimmed) value.status = trimmed;
        }

        if (query.applicationStatus !== undefined && typeof query.applicationStatus === 'string') {
            const trimmed = query.applicationStatus.trim();
            if (trimmed) value.applicationStatus = trimmed;
        }

        if (query.customerId !== undefined) {
            const customerId = Number(query.customerId);
            if (Number.isSafeInteger(customerId) && customerId > 0) {
                value.customerId = customerId;
            }
        }

        if (query.invoiceNumber !== undefined && typeof query.invoiceNumber === 'string') {
            const trimmed = query.invoiceNumber.trim();
            if (trimmed) value.invoiceNumber = trimmed;
        }

        if (query.from !== undefined) {
            const from = validDate(query.from);
            if (!from) errors.push({ field: 'from', message: 'From date must be YYYY-MM-DD' });
            else value.from = from;
        }

        if (query.to !== undefined) {
            const to = validDate(query.to);
            if (!to) errors.push({ field: 'to', message: 'To date must be YYYY-MM-DD' });
            else value.to = to;
        }

        if (value.from && value.to && value.to < value.from) {
            errors.push({ field: 'to', message: 'To date must be on or after from date' });
        }
    }

    return { errors, value };
}

export function validateCancelReturn(body) {
    if (body === undefined || body === null) return { errors: [], value: {} };
    if (!isObject(body) || Object.keys(body).some((field) => field !== 'reason')) {
        return { errors: [{ field: 'body', message: 'Only a reason field is supported' }], value: {} };
    }
    if (body.reason === undefined || body.reason === null || body.reason === '') return { errors: [], value: {} };
    if (typeof body.reason !== 'string' || body.reason.trim().length > 500) {
        return {
            errors: [{ field: 'reason', message: 'Reason must be a string of at most 500 characters' }],
            value: {},
        };
    }
    return { errors: [], value: { reason: body.reason.trim() } };
}

export function validateCreditEntryReversal(body) {
    if (!isObject(body) || Object.keys(body).some((field) => field !== 'reason')) {
        return { errors: [{ field: 'body', message: 'Only a reason field is supported' }], value: {} };
    }
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
        return {
            errors: [{ field: 'reason', message: 'A reason is required and must be at most 500 characters' }],
            value: {},
        };
    }
    return { errors: [], value: { reason: body.reason.trim() } };
}

/** Applying customer credit needs an invoice and an amount, nothing else. */
export function validateCustomerCreditApplication(body) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
    }
    const allowed = new Set(['invoiceId', 'amount']);
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Field is not supported' });
    }

    const invoiceId = positiveId(body.invoiceId);
    if (!invoiceId) errors.push({ field: 'invoiceId', message: 'Invoice ID must be a positive integer' });
    else value.invoiceId = invoiceId;

    const amount = currency(body.amount);
    if (amount === null) {
        errors.push({ field: 'amount', message: 'Amount must be positive with at most two decimals' });
    } else {
        value.amount = amount;
    }

    return { errors, value };
}

/**
 * Granting customer credit: an amount plus the mandatory audit reason,
 * with an optional reference (voucher, advance number, ...).
 */
export function validateGrantCredit(body) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
    }
    const allowed = new Set(['amount', 'reason', 'reference']);
    for (const field of Object.keys(body)) {
        if (!allowed.has(field)) errors.push({ field, message: 'Field is not supported' });
    }

    const amount = currency(body.amount);
    if (amount === null) {
        errors.push({ field: 'amount', message: 'Amount must be positive with at most two decimals' });
    } else {
        value.amount = amount;
    }

    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) {
        errors.push({ field: 'reason', message: 'A reason is required and must be at most 500 characters' });
    } else {
        value.reason = body.reason.trim();
    }

    if (body.reference !== undefined && body.reference !== null && body.reference !== '') {
        if (typeof body.reference !== 'string' || body.reference.trim().length > 100) {
            errors.push({ field: 'reference', message: 'Reference must be a string of at most 100 characters' });
        } else {
            value.reference = body.reference.trim();
        }
    }

    return { errors, value };
}

export function validateRegisterQuery(query) {
    const errors = [];
    const value = { page: 1, limit: 20, type: 'all' };
    const allowed = new Set(['page', 'limit', 'search', 'type', 'status', 'from', 'to']);

    if (query && typeof query === 'object') {
        for (const field of Object.keys(query)) {
            if (!allowed.has(field)) errors.push({ field, message: 'Filter field is not supported' });
        }

        if (query.page !== undefined) {
            const page = Number(query.page);
            if (!Number.isSafeInteger(page) || page < 1) {
                errors.push({ field: 'page', message: 'Page must be a positive integer' });
            } else {
                value.page = page;
            }
        }
        if (query.limit !== undefined) {
            const limit = Number(query.limit);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                errors.push({ field: 'limit', message: 'Limit must be between 1 and 100' });
            } else {
                value.limit = limit;
            }
        }
        if (query.search !== undefined && typeof query.search === 'string') {
            const trimmed = query.search.trim();
            if (trimmed) value.search = trimmed.slice(0, 200);
        }
        if (query.type !== undefined && query.type !== null && query.type !== '') {
            if (!['all', 'invoices', 'returns', 'credits'].includes(query.type)) {
                errors.push({ field: 'type', message: 'Type must be all, invoices, returns or credits' });
            } else {
                value.type = query.type;
            }
        }
        if (query.status !== undefined && query.status !== null && query.status !== '') {
            if (typeof query.status !== 'string') {
                errors.push({ field: 'status', message: 'Status must be a string' });
            } else {
                value.status = query.status.trim();
            }
        }
        if (query.from !== undefined) {
            const from = validDate(query.from);
            if (!from) errors.push({ field: 'from', message: 'From date must be YYYY-MM-DD' });
            else value.from = from;
        }
        if (query.to !== undefined) {
            const to = validDate(query.to);
            if (!to) errors.push({ field: 'to', message: 'To date must be YYYY-MM-DD' });
            else value.to = to;
        }
        if (value.from && value.to && value.to < value.from) {
            errors.push({ field: 'to', message: 'To date must be on or after from date' });
        }
    }

    return { errors, value };
}
