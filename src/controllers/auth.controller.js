import * as authService from '../services/auth.service.js';

/**
 * Controllers stay thin: they translate HTTP <-> service calls only.
 * Validation and normalisation already happened in the validateBody middleware,
 * so req.validated is authoritative. Express 5 forwards rejected promises
 * from async handlers to the error middleware automatically.
 */

export async function signup(req, res) {
    const { user } = await authService.signup(req.validated);

    return res.status(201).json({
        success: true,
        message: 'Account created successfully',
        data: { user },
    });
}

export async function signin(req, res) {
    const { token, expiresIn, user } = await authService.signin(req.validated);

    return res.status(200).json({
        success: true,
        message: 'Signed in successfully',
        data: {
            token,
            tokenType: 'Bearer',
            expiresIn,
            user,
        },
    });
}

/**
 * Returns the caller's identity as decoded from a verified token.
 * Useful for the frontend to validate a stored token on page load.
 */
export function me(req, res) {
    return res.status(200).json({
        success: true,
        data: {
            user: {
                id: Number(req.user.sub),
                email: req.user.email,
            },
        },
    });
}
