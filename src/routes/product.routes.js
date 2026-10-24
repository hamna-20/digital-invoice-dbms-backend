import express from 'express';
import * as productController from '../controllers/product.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCreateProduct,
    validateProductId,
    validateProductListQuery,
    validateProductStatus,
    validateUpdateProduct,
} from '../validators/product.validator.js';

const router = express.Router();

function validateQuery(req, res, next) {
    const { errors, value } = validateProductListQuery(req.query);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedQuery = value;
    return next();
}

function validateId(req, res, next) {
    const { errors, value } = validateProductId(req.params.id);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedId = value;
    return next();
}

router.use(authenticate);

router.post('/', validateBody(validateCreateProduct), productController.create);
router.get('/', validateQuery, productController.list);
router.get('/:id', validateId, productController.getById);
router.put('/:id', validateId, validateBody(validateUpdateProduct), productController.update);
router.patch('/:id/status', validateId, validateBody(validateProductStatus), productController.setStatus);
router.delete('/:id', validateId, productController.remove);

export default router;
