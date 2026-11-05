import { searchHsCodes, getAllowedUomsSafe } from '../services/fbr.reference.js';
import ApiError from '../utils/ApiError.js';

const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;

/**
 * @route GET /api/reference/hs-codes?search=laptop&limit=20
 * Type-ahead search over the locally seeded PCT/HS code list.
 */
export async function listHsCodes(req, res, next) {
    try {
        const search = String(req.query.search ?? '').trim();
        if (search.length < 2) {
            return res.status(200).json({ success: true, data: { results: [], query: search } });
        }

        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
        const results = await searchHsCodes(search, limit);
        return res.status(200).json({ success: true, data: { results, query: search } });
    } catch (error) {
        return next(error);
    }
}

/**
 * @route GET /api/reference/hs-uoms?hsCode=8471.3000
 * Allowed UOMs for an HS code, when the FBR reference API is configured;
 * otherwise an empty list with configured=false so the UI can fall back to
 * the built-in UOM list.
 */
export async function listHsUoms(req, res, next) {
    try {
        const hsCode = String(req.query.hsCode ?? '').trim();
        if (!HS_CODE_PATTERN.test(hsCode)) {
            throw ApiError.badRequest('hsCode must be in the format 1234.5678');
        }

        const { uoms, configured } = await getAllowedUomsSafe(hsCode);
        return res.status(200).json({ success: true, data: { hsCode, uoms, configured } });
    } catch (error) {
        return next(error);
    }
}
