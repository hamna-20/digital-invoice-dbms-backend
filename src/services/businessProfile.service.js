import prisma from '../db/prisma.js';
import { FBR_PROVINCES } from '../utils/fbr.js';

const profileSelect = {
    id: true,
    businessName: true,
    ntn: true,
    strn: true,
    province: true,
    address: true,
    email: true,
    phone: true,
    createdAt: true,
    updatedAt: true,
};

const emptyProfile = () => ({
    id: null,
    businessName: null,
    ntn: null,
    strn: null,
    province: null,
    address: null,
    email: null,
    phone: null,
    createdAt: null,
    updatedAt: null,
});

function serializeProfile(profile) {
    if (!profile) return emptyProfile();
    return { ...profile };
}

/** One seller profile per account; a missing row reads as empty defaults. */
export async function getBusinessProfile(userId) {
    const profile = await prisma.businessProfile.findUnique({
        where: { userId },
        select: profileSelect,
    });
    return serializeProfile(profile);
}

/** Creates or replaces the seller profile fields supplied by the client. */
export async function updateBusinessProfile(userId, input) {
    const profile = await prisma.businessProfile.upsert({
        where: { userId },
        create: { userId, ...input },
        update: input,
        select: profileSelect,
    });
    return serializeProfile(profile);
}

/** The seller fields needed by the mock payload, read inside a transaction too. */
export async function loadSellerProfile(db, userId) {
    const profile = await db.businessProfile.findUnique({
        where: { userId },
        select: {
            businessName: true,
            ntn: true,
            strn: true,
            province: true,
            address: true,
            email: true,
            phone: true,
        },
    });
    return profile ?? {};
}

export const BUSINESS_PROFILE_PROVINCES = FBR_PROVINCES;
