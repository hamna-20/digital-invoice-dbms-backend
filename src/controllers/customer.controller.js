import * as customerService from '../services/customer.service.js';
import ApiError from '../utils/ApiError.js';

function authenticatedUserId(req) {
    const userId = Number(req.user?.sub);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        throw ApiError.unauthorized('Invalid authenticated user');
    }
    return userId;
}

export async function create(req, res) {
    const customer = await customerService.createCustomer(authenticatedUserId(req), req.validated);
    return res.status(201).json({
        success: true,
        message: 'Customer created successfully',
        data: { customer },
    });
}

export async function list(req, res) {
    const result = await customerService.listCustomers(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({
        success: true,
        data: result,
    });
}

export async function getById(req, res) {
    const customer = await customerService.getCustomer(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        data: { customer },
    });
}

export async function update(req, res) {
    const customer = await customerService.updateCustomer(
        authenticatedUserId(req),
        req.validatedId,
        req.validated
    );
    return res.status(200).json({
        success: true,
        message: 'Customer updated successfully',
        data: { customer },
    });
}

export async function remove(req, res) {
    await customerService.deleteCustomer(authenticatedUserId(req), req.validatedId);
    return res.status(204).end();
}
