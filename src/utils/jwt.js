import jwt from 'jsonwebtoken';
import config from '../config/index.js';

/**
 * JWT signing/verification.
 *
 * The algorithm is pinned to HS256 on both sides. Pinning on verify prevents
 * "algorithm confusion" attacks where a token is re-signed with a different
 * algorithm (e.g. `none` or RS256 using the public key as HMAC secret).
 */

const ALGORITHM = 'HS256';

export function signAccessToken(payload) {
    return jwt.sign(payload, config.jwt.secret, {
        algorithm: ALGORITHM,
        expiresIn: config.jwt.expiresIn,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
    });
}

/**
 * Throws if the token is malformed, expired, or was not issued by us.
 * The caller decides how to map failure to an HTTP response.
 */
export function verifyAccessToken(token) {
    return jwt.verify(token, config.jwt.secret, {
        algorithms: [ALGORITHM],
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
    });
}
