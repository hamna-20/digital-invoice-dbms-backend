import express from 'express';
import * as customerController from '../controllers/customer.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import {
    validateCreateCustomer,
    validateCustomerId,
    validateCustomerListQuery,
    validateUpdateCustomer,
} from '../validators/customer.validator.js';

const router = express.Router();

function validateQuery(req, res, next) {
    const { errors, value } = validateCustomerListQuery(req.query);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedQuery = value;
    return next();
}

function validateId(req, res, next) {
    const { errors, value } = validateCustomerId(req.params.id);
    if (errors.length) return next(ApiError.badRequest('Validation failed', errors));
    req.validatedId = value;
    return next();
}

router.use(authenticate);

router.post('/', validateBody(validateCreateCustomer), customerController.create);
router.get('/', validateQuery, customerController.list);
router.get('/:id', validateId, customerController.getById);
router.put('/:id', validateId, validateBody(validateUpdateCustomer), customerController.update);
router.delete('/:id', validateId, customerController.remove);

export default router;
