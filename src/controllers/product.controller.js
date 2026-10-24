import * as productService from '../services/product.service.js';
import ApiError from '../utils/ApiError.js';

function authenticatedUserId(req) {
    const userId = Number(req.user?.sub);
    if (!Number.isSafeInteger(userId) || userId < 1) {
        throw ApiError.unauthorized('Invalid authenticated user');
    }
    return userId;
}

export async function create(req, res) {
    const product = await productService.createProduct(authenticatedUserId(req), req.validated);
    return res.status(201).json({
        success: true,
        message: 'Product created successfully',
        data: { product },
    });
}

export async function list(req, res) {
    const result = await productService.listProducts(authenticatedUserId(req), req.validatedQuery);
    return res.status(200).json({
        success: true,
        data: result,
    });
}

export async function getById(req, res) {
    const product = await productService.getProduct(authenticatedUserId(req), req.validatedId);
    return res.status(200).json({
        success: true,
        data: { product },
    });
}

export async function update(req, res) {
    const product = await productService.updateProduct(
        authenticatedUserId(req),
        req.validatedId,
        req.validated
    );
    return res.status(200).json({
        success: true,
        message: 'Product updated successfully',
        data: { product },
    });
}

export async function setStatus(req, res) {
    const product = await productService.setProductStatus(
        authenticatedUserId(req),
        req.validatedId,
        req.validated.isActive
    );
    return res.status(200).json({
        success: true,
        message: `Product ${product.isActive ? 'activated' : 'deactivated'} successfully`,
        data: { product },
    });
}

export async function remove(req, res) {
    await productService.deleteProduct(authenticatedUserId(req), req.validatedId);
    return res.status(204).end();
}
