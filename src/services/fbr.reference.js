import { PrismaClient } from '@prisma/client';
import { PrismaMssql } from '@prisma/adapter-mssql';

// In-memory cache for UOM lookup (24 hours)
const uomCache = new Map();

// Prisma 7 requires a driver adapter and does not accept a datasource URL
// directly on the client constructor.
const adapter = new PrismaMssql(process.env.DATABASE_URL, {
    onPoolError(error) {
        console.error('[prisma] pool error:', error?.message ?? error);
    },
    onConnectionError(error) {
        console.error('[prisma] connection error:', error?.message ?? error);
    },
});

const prisma = new PrismaClient({ adapter });

/**
 * Sync HS codes from the FBR reference endpoint.
 * Calls GET /pdi/v1/itemdesccode and upserts rows into FbrHsCode.
 * Only called from a script, not on request.
 * 
 * @throws {Error} "FBR reference data not configured" if FBR_TOKEN is not set
 */
async function syncHsCodes() {
    const baseUrl = process.env.FBR_BASE_URL;
    const token = process.env.FBR_TOKEN;

    if (!token) {
        throw new Error('FBR reference data not configured');
    }

    // Use native fetch (available in Node.js 18+ with ESM)
    const response = await fetch(`${baseUrl}/pdi/v1/itemdesccode`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`FBR API error: ${response.status}`);
    }

    const hsCodes = await response.json();

    // Upsert each HS code into the database
    for (const hsCode of hsCodes) {
        await prisma.fbrHsCode.upsert({
            where: { hsCode: hsCode.hsCode },
            update: {
                description: hsCode.description,
                updatedAt: new Date(),
            },
            create: {
                hsCode: hsCode.hsCode,
                description: hsCode.description,
                updatedAt: new Date(),
            },
        });
    }

    console.log(`Synced ${hsCodes.length} HS codes from FBR reference data`);
}

/**
 * Validate that an HS code has the correct format and exists in the FbrHsCode table.
 * 
 * Format: /^\d{4}\.\d{4}$/ (e.g., "0101.2100")
 * 
 * @param {string} code - The HS code to validate
 * @returns {Promise<boolean>} - True if the code is valid and exists in FbrHsCode
 * @throws {Error} "FBR reference data not configured" if FBR_TOKEN is not set
 */
export async function isValidHsCode(code) {
    const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;

    if (!code || !HS_CODE_PATTERN.test(code)) {
        return false;
    }

    if (!process.env.FBR_TOKEN) {
        throw new Error('FBR reference data not configured');
    }

    // Check if the code exists in the FbrHsCode table
    const existing = await prisma.fbrHsCode.findUnique({
        where: { hsCode: code },
    });

    return !!existing;
}

/**
 * Get allowed UOMs for a given HS code from the FBR API.
 * Calls GET /pdi/v2/HS_UOM?hs_code=...&annexure_id=3 and returns the list.
 * Caches result in memory for 24 hours.
 * 
 * @param {string} hsCode - The HS code to get UOMs for
 * @returns {Promise<Array>} - List of allowed UOMs
 * @throws {Error} "FBR reference data not configured" if FBR_TOKEN is not set
 */
export async function getAllowedUOMs(hsCode) {
    const baseUrl = process.env.FBR_BASE_URL;
    const token = process.env.FBR_TOKEN;

    if (!token) {
        throw new Error('FBR reference data not configured');
    }

    // Check cache first (24 hours = 86400000 ms)
    const cacheKey = `uom_${hsCode}`;
    const cached = uomCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 86400000) {
        return cached.data;
    }

    // Use native fetch (available in Node.js 18+ with ESM)
    const response = await fetch(`${baseUrl}/pdi/v2/HS_UOM`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        params: {
            hs_code: hsCode,
            annexure_id: 3,
        },
    });

    if (!response.ok) {
        throw new Error(`FBR API error: ${response.status}`);
    }

    const uoms = await response.json();

    // Cache the result
    uomCache.set(cacheKey, {
        data: uoms,
        timestamp: Date.now(),
    });

    return uoms;
}

export default {
    syncHsCodes,
    isValidHsCode,
    getAllowedUOMs,
};