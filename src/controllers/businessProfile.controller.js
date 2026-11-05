import * as businessProfileService from '../services/businessProfile.service.js';
import ApiError from '../utils/ApiError.js';

function actor(req) {
    if (!req.actor) throw ApiError.unauthorized('Authentication required');
    return req.actor;
}

export async function get(req, res) {
    const profile = await businessProfileService.getBusinessProfile(actor(req).id);
    return res.status(200).json({ success: true, data: { profile } });
}

export async function update(req, res) {
    const profile = await businessProfileService.updateBusinessProfile(actor(req).id, req.validated);
    return res.status(200).json({
        success: true,
        message: 'Business profile saved',
        data: { profile },
    });
}
