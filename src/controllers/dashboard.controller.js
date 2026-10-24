import * as dashboardService from '../services/dashboard.service.js';
import ApiError from '../utils/ApiError.js';

function authenticatedUserId(req) {
    const userId = Number(req.user?.sub);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        throw ApiError.unauthorized('Invalid authenticated user');
    }
    return userId;
}

export async function summary(req, res) {
    const data = await dashboardService.getSummary(authenticatedUserId(req));
    return res.status(200).json({ success: true, data });
}
