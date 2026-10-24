import prisma from '../db/prisma.js';
import ApiError from '../utils/ApiError.js';

const customerSelect = {
    id: true,
    name: true,
    email: true,
    phone: true,
    companyName: true,
    taxNumber: true,
    registration: true,
    address: true,
    city: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
};

export async function createCustomer(userId, input) {
    return prisma.customer.create({
        data: { ...input, userId },
        select: customerSelect,
    });
}

export async function listCustomers(userId, { page, limit, search, city }) {
    const where = {
        userId,
        ...(city ? { city: { equals: city } } : {}),
        ...(search
            ? {
                  OR: [
                      { name: { contains: search } },
                      { email: { contains: search } },
                      { phone: { contains: search } },
                      { companyName: { contains: search } },
                  ],
              }
            : {}),
    };
    const [customers, total] = await Promise.all([
        prisma.customer.findMany({
            where,
            select: customerSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.customer.count({ where }),
    ]);

    return {
        customers,
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCustomer(userId, id) {
    const customer = await prisma.customer.findFirst({
        where: { id, userId },
        select: customerSelect,
    });
    if (!customer) throw ApiError.notFound('Customer not found');
    return customer;
}

export async function updateCustomer(userId, id, input) {
    const result = await prisma.customer.updateMany({
        where: { id, userId },
        data: input,
    });
    if (result.count === 0) throw ApiError.notFound('Customer not found');

    const customer = await prisma.customer.findFirst({
        where: { id, userId },
        select: customerSelect,
    });
    if (!customer) throw ApiError.notFound('Customer not found');
    return customer;
}

export async function deleteCustomer(userId, id) {
    try {
        const result = await prisma.customer.deleteMany({ where: { id, userId } });
        if (result.count === 0) throw ApiError.notFound('Customer not found');
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error?.code === 'P2003') {
            throw ApiError.conflict('Customer cannot be deleted because it is referenced by related records');
        }
        throw error;
    }
}
