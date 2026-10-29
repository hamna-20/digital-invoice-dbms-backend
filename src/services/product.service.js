import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';

const productSelect = {
    id: true,
    name: true,
    code: true,
    description: true,
    unit: true,
    price: true,
    taxRate: true,
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
        taxRate: toNumber(p.taxRate),
        stockStatus: !p.isActive ? 'inactive' : p.stockQuantity > 0 ? 'available' : 'out_of_stock',
    };
}

const isUniqueCodeViolation = (error) => error?.code === 'P2002';

export async function createProduct(userId, input) {
    try {
        const product = await prisma.product.create({
            data: { ...input, userId },
            select: productSelect,
        });
        return serializeProduct(product);
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
        const result = await prisma.product.updateMany({
            where: { id, userId },
            data: input,
        });
        if (result.count === 0) throw ApiError.notFound('Product not found');
    } catch (error) {
        if (isUniqueCodeViolation(error)) {
            throw ApiError.conflict('A product with this code already exists');
        }
        throw error;
    }

    return getProduct(userId, id);
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
