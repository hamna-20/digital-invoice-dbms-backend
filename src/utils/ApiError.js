/**
 * Operational error carrying an HTTP status code.
 * Anything that is not an ApiError is treated as an unexpected failure and
 * is reported as a generic 500 without leaking internals.
 */
export class ApiError extends Error {
    constructor(statusCode, message, details) {
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        Error.captureStackTrace?.(this, ApiError);
    }

    static badRequest(message = 'Bad request', details) {
        return new ApiError(400, message, details);
    }

    static unauthorized(message = 'Unauthorized') {
        return new ApiError(401, message);
    }

    static notFound(message = 'Not found') {
        return new ApiError(404, message);
    }

    static conflict(message = 'Conflict') {
        return new ApiError(409, message);
    }

    static tooManyRequests(message = 'Too many requests') {
        return new ApiError(429, message);
    }

    static internal(message = 'Internal server error') {
        return new ApiError(500, message);
    }
}

export default ApiError;
