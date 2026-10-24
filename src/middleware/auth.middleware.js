import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';

/**
 * Requires a valid `Authorization: Bearer <token>` header.
 * On success attaches the decoded payload to req.user.
 */
export function authenticate(req, res, next) {
    const header = req.get('authorization') || '';
    const [scheme, token, ...rest] = header.split(' ');

    if (rest.length > 0 || !/^Bearer$/i.test(scheme) || !token) {
        return next(ApiError.unauthorized('Missing or malformed Authorization header'));
    }

    try {
        req.user = verifyAccessToken(token);
        return next();
    } catch (error) {
        // Distinguish expiry from other failures for a clearer client message,
        // but never echo the underlying library error.
        if (error?.name === 'TokenExpiredError') {
            return next(ApiError.unauthorized('Token has expired'));
        }
        return next(ApiError.unauthorized('Invalid token'));
    }
}

export default authenticate;
