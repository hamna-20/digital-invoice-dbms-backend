/**
 * FBR/PRAL reference data access.
 *
 * The HS code list is seeded locally (see scripts/seed-fbr-hs-codes.mjs) from
 * the public Pakistan Customs Tariff extract, so format and existence checks
 * work offline. Allowed-UOM lookups call the FBR reference API and therefore
 * need FBR_BASE_URL and FBR_TOKEN; without them they throw
 * "FBR reference data not configured" and callers fall back to local options.
 */

import prisma from '../db/prisma.js';

const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;
export const FBR_REFERENCE_NOT_CONFIGURED = 'FBR reference data not configured';

// In-memory cache for UOM lookup (24 hours)
const UOM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const uomCache = new Map();

/** Validates format and local existence. Exact-match, case-insensitive on code. */
export async function isValidHsCode(code) {
    const normalized = String(code ?? '').trim();
    if (!HS_CODE_PATTERN.test(normalized)) {
        return false;
    }

    const existing = await prisma.fbrHsCode.findUnique({
        where: { hsCode: normalized },
        select: { hsCode: true },
    });

    return !!existing;
}

const escapeLikeWildcards = (value) => String(value).replace(/[%_[\]]/g, '');

/**
 * Type-ahead search for the HS code picker. Matches digits anywhere in the
 * code and case-insensitive substrings of the description. Results are
 * ordered by code and capped (default 20, max 50).
 */
export async function searchHsCodes(query, limit = 20) {
    const q = escapeLikeWildcards(String(query ?? '').trim());
    if (q.length < 2) return [];

    const take = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
    const digits = q.replace(/\D/g, '');
    const codeNeedle = digits.length >= 4 ? `${digits.slice(0, 4)}.${digits.slice(4)}` : q;

    const where =
        digits.length >= 4
            ? { OR: [{ hsCode: { startsWith: codeNeedle } }, { description: { contains: q } }] }
            : { OR: [{ hsCode: { contains: q } }, { description: { contains: q } }] };

    const rows = await prisma.fbrHsCode.findMany({
        where,
        select: { hsCode: true, description: true },
        orderBy: { hsCode: 'asc' },
        take,
    });

    return rows;
}

/** Count of locally seeded reference rows (used by health/diagnostics). */
export async function countHsCodes() {
    return prisma.fbrHsCode.count();
}

/**
 * FBR returns its UOM lists in a few different shapes depending on the
 * endpoint version; normalise everything to a unique list of UOM names.
 */
function normalizeUomList(payload) {
    const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.uoms)
            ? payload.uoms
            : Array.isArray(payload?.UOM)
              ? payload.UOM
              : [];

    const names = [];
    for (const item of list) {
        const name =
            typeof item === 'string'
                ? item.trim()
                : String(item?.uom ?? item?.UOM ?? item?.unit ?? item?.uomName ?? item?.name ?? '').trim();
        if (name) names.push(name);
    }
    return [...new Set(names)];
}

/**
 * Get allowed UOMs for a given HS code from the FBR API.
 * Calls GET /pdi/v2/HS_UOM?hs_code=...&annexure_id=3 and returns a string[].
 * Caches result in memory for 24 hours.
 *
 * @param {string} hsCode - The HS code to get UOMs for
 * @returns {Promise<string[]>} - List of allowed UOMs
 * @throws {Error} "FBR reference data not configured" if FBR_TOKEN is not set
 */
export async function getAllowedUOMs(hsCode) {
    const baseUrl = process.env.FBR_BASE_URL;
    const token = process.env.FBR_TOKEN;

    if (!token || !baseUrl) {
        throw new Error(FBR_REFERENCE_NOT_CONFIGURED);
    }

    const normalized = String(hsCode ?? '').trim();
    if (!HS_CODE_PATTERN.test(normalized)) {
        return [];
    }

    const cacheKey = `uom_${normalized}`;
    const cached = uomCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < UOM_CACHE_TTL_MS) {
        return cached.data;
    }

    const url = `${String(baseUrl).replace(/\/+$/, '')}/pdi/v2/HS_UOM?hs_code=${encodeURIComponent(
        normalized
    )}&annexure_id=3`;

    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
        });
    } catch {
        throw new Error('Unable to reach the FBR reference service');
    }

    if (!response.ok) {
        throw new Error(`FBR API error: ${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const uoms = normalizeUomList(payload);

    uomCache.set(cacheKey, { data: uoms, timestamp: Date.now() });

    return uoms;
}

/**
 * List of UOMs the caller may choose for the given HS code. When FBR is not
 * configured, returns an empty list instead of throwing so the UI can fall
 * back to the built-in option list.
 */
export async function getAllowedUomsSafe(hsCode) {
    try {
        return { uoms: await getAllowedUOMs(hsCode), configured: true };
    } catch (error) {
        if (error?.message === FBR_REFERENCE_NOT_CONFIGURED) {
            return { uoms: [], configured: false };
        }
        throw error;
    }
}

export default {
    isValidHsCode,
    searchHsCodes,
    countHsCodes,
    getAllowedUOMs,
    getAllowedUomsSafe,
};
