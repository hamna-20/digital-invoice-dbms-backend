import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';
import { isValidHsCode, getAllowedUOMs } from '../services/fbr.reference.js';

const productSelect = {
    id: true,
    name: true,
    code: true,
    description: true,
    unit: true,
    packing: true,
    weight: true,
    price: true,
    retailPrice: true,
    taxRate: true,
    hsCode: true,
    saleType: true,
    sroScheduleNo: true,
    sroItemSerialNo: true,
    extraTaxRate: true,
    furtherTaxRate: true,
    advanceTaxRate: true,
    fedRate: true,
    salesTaxWithheldRate: true,
    stockQuantity: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
};

/**
 * Prisma returns Decimal instances, which JSON-serialise as strings.
 * Convert them to numbers so the API contract is consistent for clients.
 */
function serializeProduct(product) {
    const toNumber = (value) => (value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value));
    const p = product;
    return {
        ...p,
        price: toNumber(p.price),
        retailPrice: p.retailPrice === null || p.retailPrice === undefined ? null : toNumber(p.retailPrice),
        weight: toNumber(p.weight),
        taxRate: toNumber(p.taxRate),
        extraTaxRate: toNumber(p.extraTaxRate),
        furtherTaxRate: toNumber(p.furtherTaxRate),
        advanceTaxRate: toNumber(p.advanceTaxRate),
        fedRate: toNumber(p.fedRate),
        salesTaxWithheldRate: toNumber(p.salesTaxWithheldRate),
        stockStatus: !p.isActive ? 'inactive' : p.stockQuantity > 0 ? 'available' : 'out_of_stock',
    };
}

const isUniqueCodeViolation = (error) => error?.code === 'P2002';

export async function createProduct(userId, input) {
    try {
        // Validate hsCode format and existence if provided
        let warnings = [];
        if (input.hsCode) {
            try {
                const isValid = await isValidHsCode(input.hsCode);
                if (!isValid) {
                    throw ApiError.badRequest('HS code must be valid in FBR format (e.g. 1234.5678) and selected from FBR list');
                }
            } catch (error) {
                // If FBR reference data is not configured, allow save with warning
                if (error.message === 'FBR reference data not configured') {
                    warnings.push('HS code validation skipped: FBR reference data not configured');
                } else {
                    throw error;
                }
            }
            // Check unit is valid for the given HS code if both are provided
            if (input.unit && input.hsCode) {
                try {
                    const allowedUOMs = await getAllowedUOMs(input.hsCode);
                    const allowedLower = allowedUOMs.map((uom) => String(uom).trim().toLowerCase());
                    if (!allowedLower.includes(String(input.unit).trim().toLowerCase())) {
                        throw ApiError.badRequest(`Unit must be one of: ${allowedUOMs.join(', ')}`);
                    }
                } catch (error) {
                    // If FBR reference data is not configured, allow save with warning
                    if (error.message === 'FBR reference data not configured') {
                        warnings.push('UOM validation skipped: FBR reference data not configured');
                    } else {
                        throw error;
                    }
                }
            }
        }

        // Check for duplicate name + hsCode combination
        let duplicateWarning = false;
        if (input.name && input.hsCode) {
            const existingProduct = await prisma.product.findFirst({
                where: {
                    userId,
                    name: input.name,
                    hsCode: input.hsCode,
                },
            });
            // For create, any existing product with same name+hsCode is a duplicate
            // For update, exclude the current product being updated
            if (existingProduct) {
                if (input.id && existingProduct.id === Number(input.id)) {
                    // This is the product being updated, not a duplicate
                } else {
                    duplicateWarning = true;
                }
            }
        }
        if (duplicateWarning) {
            warnings.push('Another product has the same name and HS code');
        }

        const product = await prisma.product.create({
            data: { ...input, userId },
            select: productSelect,
        });
        return { ...serializeProduct(product), warnings };
    } catch (error) {
        if (isUniqueCodeViolation(error)) {
            throw ApiError.conflict('A product with this code already exists');
        }
        throw error;
    }
}

export async function listProducts(userId, { page, limit, search, isActive, unit }) {
    const where = {
        userId,
        ...(isActive === undefined ? {} : { isActive }),
        ...(unit ? { unit } : {}),
        ...(search
            ? {
                  OR: [
                      { name: { contains: search } },
                      { code: { contains: search } },
                      { description: { contains: search } },
                  ],
              }
            : {}),
    };

    const [products, total] = await Promise.all([
        prisma.product.findMany({
            where,
            select: productSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.product.count({ where }),
    ]);

    return {
        products: products.map(serializeProduct),
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getProduct(userId, id) {
    const product = await prisma.product.findFirst({
        where: { id, userId },
        select: productSelect,
    });
    if (!product) throw ApiError.notFound('Product not found');
    return serializeProduct(product);
}

export async function updateProduct(userId, id, input) {
    try {
        // Validate hsCode format and existence if provided
        let warnings = [];
        if (input.hsCode) {
            try {
                const isValid = await isValidHsCode(input.hsCode);
                if (!isValid) {
                    throw ApiError.badRequest('HS code must be valid in FBR format (e.g. 1234.5678) and selected from FBR list');
                }
            } catch (error) {
                // If FBR reference data is not configured, allow update with warning
                if (error.message === 'FBR reference data not configured') {
                    warnings.push('HS code validation skipped: FBR reference data not configured');
                } else {
                    throw error;
                }
            }
            // Check unit is valid for the given HS code if both are provided
            if (input.unit && input.hsCode) {
                try {
                    const allowedUOMs = await getAllowedUOMs(input.hsCode);
                    const allowedLower = allowedUOMs.map((uom) => String(uom).trim().toLowerCase());
                    if (!allowedLower.includes(String(input.unit).trim().toLowerCase())) {
                        throw ApiError.badRequest(`Unit must be one of: ${allowedUOMs.join(', ')}`);
                    }
                } catch (error) {
                    // If FBR reference data is not configured, allow update with warning
                    if (error.message === 'FBR reference data not configured') {
                        warnings.push('UOM validation skipped: FBR reference data not configured');
                    } else {
                        throw error;
                    }
                }
            }
        }

        // Check for duplicate name + hsCode combination (excluding current product)
        if (input.name && input.hsCode) {
            const existingProduct = await prisma.product.findFirst({
                where: {
                    userId,
                    name: input.name,
                    hsCode: input.hsCode,
                },
            });
            // Exclude the current product being updated
            if (existingProduct && existingProduct.id !== Number(id)) {
                warnings.push('Another product has the same name and HS code');
            }
        }

        const result = await prisma.product.updateMany({
            where: { id, userId },
            data: input,
        });
        if (result.count === 0) throw ApiError.notFound('Product not found');

        return { ...await getProduct(userId, id), warnings };
    } catch (error) {
        if (isUniqueCodeViolation(error)) {
            throw ApiError.conflict('A product with this code already exists');
        }
        throw error;
    }
}

export async function setProductStatus(userId, id, isActive) {
    const result = await prisma.product.updateMany({
        where: { id, userId },
        data: { isActive },
    });
    if (result.count === 0) throw ApiError.notFound('Product not found');

    return getProduct(userId, id);
}

export async function deleteProduct(userId, id) {
    try {
        const result = await prisma.product.deleteMany({ where: { id, userId } });
        if (result.count === 0) throw ApiError.notFound('Product not found');
    } catch (error) {
        if (error instanceof ApiError) throw error;
        // A foreign key (for example an invoice item referencing this product)
        // blocks the delete. Invoice history must never be removed, so tell
        // the caller to deactivate the product instead.
        if (error?.code === 'P2003') {
            throw ApiError.conflict(
                'Product is referenced by existing invoice records and cannot be deleted. Deactivate it instead.'
            );
        }
        throw error;
    }
}
