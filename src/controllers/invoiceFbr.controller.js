import * as fbrService from '../services/fbrValidation.service.js';
import ApiError from '../utils/ApiError.js';

/**
 * Internal FBR/PRAL-style mock endpoints.
 *
 * These handlers never contact FBR or PRAL. They validate the invoice against
 * the local rules, store a MOCK- reference, and return the "Mock Validated" or
 * "Mock Submitted" label. `GET` is read-only and never blocks a draft.
 */

function actor(req) {
    if (!req.actor) throw ApiError.unauthorized('Authentication required');
    return req.actor;
}

export async function getFbr(req, res, next) {
    try {
        const result = await fbrService.getInvoiceFbrReadiness(actor(req), req.validatedId);
        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return next(error);
    }
}

export async function validateFbr(req, res, next) {
    try {
        const result = await fbrService.mockValidateInvoice(actor(req), req.validatedId);
        return res.status(200).json({
            success: true,
            message: 'Validation recorded. This invoice has not been submitted to FBR.',
            data: result,
        });
    } catch (error) {
        return next(error);
    }
}

export async function submitFbr(req, res, next) {
    try {
        const result = await fbrService.mockSubmitInvoice(actor(req), req.validatedId);
        return res.status(200).json({
            success: true,
            message: 'Submission recorded.',
            data: result,
        });
    } catch (error) {
        return next(error);
    }
}
