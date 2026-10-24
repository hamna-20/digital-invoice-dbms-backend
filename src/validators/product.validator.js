/**
 * Product request validation.
 *
 * Every validator returns { errors, value }. `value` only ever contains
 * explicitly allowed fields, which is what prevents mass assignment: the
 * controllers/services never read req.body directly.
 */

const TEXT_LIMITS = {
    name: 200,
    code: 50,
    description: 4000,
    unit: 30,
};

const BODY_FIELDS = new Set([
    'name',
    'code',
    'description',
    'unit',
    'price',
    'taxRate',
    'stockQuantity',
    'isActive',
]);

const QUERY_FIELDS = new Set(['page', 'limit', 'search', 'isActive', 'unit']);

// DECIMAL(18,2) can hold more than JavaScript can represent exactly.
// This ceiling keeps the scaled value inside the safe-integer range.
const MAX_PRICE = 9999999999999.99;
const MAX_TAX_RATE = 100;
const MAX_STOCK = 2147483647;
const MAX_SQL_SERVER_INT = 2147483647;
const MAX_SEARCH_LENGTH = 200;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Accepts plain decimal notation, including ".5" and "1.", but not exponents.
const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_PATTERN = /^-?\d+$/;

const isBlank = (input) =>
    input === undefined || input === null || (typeof input === 'string' && input.trim() === '');

const collapseWhitespace = (input) => input.trim().replace(/\s+/g, ' ');

function parseDecimal(field, input, maximum, label, errors) {
    let text;

    if (typeof input === 'number') {
        if (!Number.isFinite(input)) {
            errors.push({ field, message: `${label} must be a finite number` });
            return undefined;
        }
        text = String(input);
    } else if (typeof input === 'string') {
        text = input.trim();
    } else {
        errors.push({ field, message: `${label} must be a number` });
        return undefined;
    }

    if (!DECIMAL_PATTERN.test(text)) {
        errors.push({ field, message: `${label} must be a number` });
        return undefined;
    }

    const normalized = text.endsWith('.') ? text.slice(0, -1) : text;
    const fraction = normalized.split('.')[1] || '';
    if (fraction.length > 2) {
        errors.push({ field, message: `${label} must have at most 2 decimal places` });
        return undefined;
    }

    const number = Number(normalized);
    if (!Number.isFinite(number)) {
        errors.push({ field, message: `${label} must be a finite number` });
        return undefined;
    }
    if (number < 0) {
        errors.push({ field, message: `${label} must not be negative` });
        return undefined;
    }
    if (number > maximum) {
        errors.push({ field, message: `${label} must be no greater than ${maximum}` });
        return undefined;
    }

    // Avoid returning -0.
    return number === 0 ? 0 : number;
}

function parseInteger(field, input, maximum, label, errors) {
    let text;

    if (typeof input === 'number') {
        if (!Number.isFinite(input) || !Number.isInteger(input)) {
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

    if (!INTEGER_PATTERN.test(text)) {
        errors.push({ field, message: `${label} must be a whole number` });
        return undefined;
    }

    const number = Number(text);
    if (number < 0) {
        errors.push({ field, message: `${label} must not be negative` });
        return undefined;
    }
    if (!Number.isSafeInteger(number) || number > maximum) {
        errors.push({ field, message: `${label} must be no greater than ${maximum}` });
        return undefined;
    }

    return number;
}

function validateProductBody(body, partial) {
    const errors = [];
    const value = {};

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value,
        };
    }

    for (const field of Object.keys(body)) {
        if (!BODY_FIELDS.has(field)) {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    if (!partial || Object.hasOwn(body, 'name')) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
            errors.push({ field: 'name', message: 'Name is required and must not be empty' });
        } else {
            const name = collapseWhitespace(body.name);
            if (name.length > TEXT_LIMITS.name) {
                errors.push({ field: 'name', message: `Name must be at most ${TEXT_LIMITS.name} characters` });
            } else {
                value.name = name;
            }
        }
    }

    if (!partial || Object.hasOwn(body, 'code')) {
        if (typeof body.code !== 'string' || !body.code.trim()) {
            errors.push({ field: 'code', message: 'Code is required and must not be empty' });
        } else {
            // Codes are stored upper-case so a SKU is represented identically
            // no matter how the client typed it.
            const code = collapseWhitespace(body.code).toUpperCase();
            if (code.length > TEXT_LIMITS.code) {
                errors.push({ field: 'code', message: `Code must be at most ${TEXT_LIMITS.code} characters` });
            } else {
                value.code = code;
            }
        }
    }

    for (const field of ['description', 'unit']) {
        if (partial && !Object.hasOwn(body, field)) continue;

        const input = body[field];
        if (isBlank(input)) {
            value[field] = null;
            continue;
        }
        if (typeof input !== 'string') {
            errors.push({ field, message: 'Must be a string or null' });
            continue;
        }

        const normalized = field === 'unit' ? collapseWhitespace(input).toLowerCase() : input.trim();
        if (normalized.length > TEXT_LIMITS[field]) {
            errors.push({ field, message: `Must be at most ${TEXT_LIMITS[field]} characters` });
        } else {
            value[field] = normalized || null;
        }
    }

    if (!partial || Object.hasOwn(body, 'price')) {
        if (isBlank(body.price)) {
            errors.push({ field: 'price', message: 'Price is required' });
        } else {
            const price = parseDecimal('price', body.price, MAX_PRICE, 'Price', errors);
            if (price !== undefined) value.price = price;
        }
    }

    if (!partial || Object.hasOwn(body, 'taxRate')) {
        if (!Object.hasOwn(body, 'taxRate') || isBlank(body.taxRate)) {
            if (partial) {
                errors.push({ field: 'taxRate', message: 'Tax rate must be a number' });
            } else {
                value.taxRate = 0;
            }
        } else {
            const taxRate = parseDecimal('taxRate', body.taxRate, MAX_TAX_RATE, 'Tax rate', errors);
            if (taxRate !== undefined) value.taxRate = taxRate;
        }
    }

    if (!partial || Object.hasOwn(body, 'stockQuantity')) {
        if (!Object.hasOwn(body, 'stockQuantity') || isBlank(body.stockQuantity)) {
            if (partial) {
                errors.push({ field: 'stockQuantity', message: 'Stock quantity must be a whole number' });
            } else {
                value.stockQuantity = 0;
            }
        } else {
            const stockQuantity = parseInteger(
                'stockQuantity',
                body.stockQuantity,
                MAX_STOCK,
                'Stock quantity',
                errors
            );
            if (stockQuantity !== undefined) value.stockQuantity = stockQuantity;
        }
    }

    if (!partial || Object.hasOwn(body, 'isActive')) {
        if (!Object.hasOwn(body, 'isActive')) {
            value.isActive = true;
        } else if (typeof body.isActive !== 'boolean') {
            errors.push({ field: 'isActive', message: 'Must be true or false' });
        } else {
            value.isActive = body.isActive;
        }
    }

    if (partial && Object.keys(value).length === 0 && errors.length === 0) {
        errors.push({ field: 'body', message: 'At least one product field must be provided' });
    }

    return { errors, value };
}

export function validateCreateProduct(body) {
    return validateProductBody(body, false);
}

export function validateUpdateProduct(body) {
    return validateProductBody(body, true);
}

export function validateProductStatus(body) {
    const errors = [];

    if (!isObject(body)) {
        return {
            errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
            value: {},
        };
    }

    for (const field of Object.keys(body)) {
        if (field !== 'isActive') {
            errors.push({ field, message: 'Field is not supported' });
        }
    }

    if (!Object.hasOwn(body, 'isActive')) {
        errors.push({ field: 'isActive', message: 'isActive is required' });
    } else if (typeof body.isActive !== 'boolean') {
        errors.push({ field: 'isActive', message: 'Must be true or false' });
    }

    return { errors, value: errors.length ? {} : { isActive: body.isActive } };
}

export function validateProductListQuery(query) {
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

    if (source.isActive !== undefined) {
        if (source.isActive === 'true') {
            value.isActive = true;
        } else if (source.isActive === 'false') {
            value.isActive = false;
        } else {
            errors.push({ field: 'isActive', message: 'Must be true or false' });
        }
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

    if (source.unit !== undefined) {
        if (typeof source.unit !== 'string') {
            errors.push({ field: 'unit', message: 'Must be a string' });
        } else {
            const unit = collapseWhitespace(source.unit).toLowerCase();
            if (unit.length > TEXT_LIMITS.unit) {
                errors.push({ field: 'unit', message: `Must be at most ${TEXT_LIMITS.unit} characters` });
            } else if (unit) {
                value.unit = unit;
            }
        }
    }

    return { errors, value };
}

export function validateProductId(input) {
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
        return { errors: [{ field: 'id', message: 'ID must be a positive integer' }], value: null };
    }

    const id = Number(input);
    if (!Number.isSafeInteger(id) || id > MAX_SQL_SERVER_INT) {
        return { errors: [{ field: 'id', message: 'ID is outside the supported range' }], value: null };
    }
    return { errors: [], value: id };
}
