import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';

/**
 * 404 for unmatched routes. Registered after all routes, before errorHandler.
 */
export function notFoundHandler(req, res, next) {
    next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Translates any thrown value into a safe JSON response.
 *
 * Rules:
 *  - Operational errors (ApiError) expose their message.
 *  - Known client mistakes (bad JSON, oversized payload, Prisma constraint
 *    violations) map to a helpful 4xx.
 *  - Anything else is an unexpected failure: log it server-side, but return a
 *    generic 500 so stack traces, SQL and internal details never reach clients.
 */
export function errorHandler(err, req, res, next) {
    // Delegate when the response is already streaming.
    if (res.headersSent) {
        return next(err);
    }

    let statusCode = 500;
    let message = 'Internal server error';
    let details;

    if (err instanceof ApiError) {
        statusCode = err.statusCode;
        message = err.message;
        details = err.details;
    } else if (err?.type === 'entity.parse.failed') {
        // body-parser: malformed JSON
        statusCode = 400;
        message = 'Invalid JSON in request body';
    } else if (err?.type === 'entity.too.large') {
        statusCode = 413;
        message = 'Request body is too large';
    } else if (err?.code === 'P2002') {
        // Prisma unique constraint violation (e.g. duplicate email)
        statusCode = 409;
        message = 'A record with these details already exists';
    } else if (err?.code === 'P2025') {
        statusCode = 404;
        message = 'Record not found';
    } else if (err?.code === 'P2003') {
        statusCode = 400;
        message = 'Related record constraint failed';
    }

    const isServerError = statusCode >= 500;

    if (isServerError) {
        // Log the method and URL only - never the body, which can contain
        // passwords, and never the token from headers.
        console.error(`[error] ${req.method} ${req.originalUrl} -> ${statusCode}`, {
            name: err?.name,
            message: err?.message,
            code: err?.code,
            stack: config.isProduction ? undefined : err?.stack,
        });
    }

    const body = {
        success: false,
        message,
    };

    if (details) {
        body.errors = details;
    }

    // In production, unexpected failures always look identical.
    if (isServerError && config.isProduction) {
        body.message = 'Internal server error';
    }

    return res.status(statusCode).json(body);
}

export default errorHandler;
