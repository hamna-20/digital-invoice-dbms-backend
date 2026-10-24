import ApiError from '../utils/ApiError.js';

/**
 * Runs a validator against the request body and stores the normalised result
 * on req.validated. Controllers never read req.body directly, so they always
 * receive trimmed/lower-cased values.
 *
 * @param {(body: unknown) => { errors: Array<{field: string, message: string}>, value: object }} validator
 */
export function validateBody(validator) {
    return (req, res, next) => {
        const { errors, value } = validator(req.body);

        if (errors.length > 0) {
            return next(ApiError.badRequest('Validation failed', errors));
        }

        req.validated = value;
        return next();
    };
}

export default validateBody;
