/**
 * Seeds the FBR/PCT HS code reference table (FbrHsCode) from the bundled
 * Pakistan Customs Tariff extract at prisma/data/pct-hs-codes.json.
 *
 * Provenance: extracted 2026-11 from the public "Pakistan Customs Tariff
 * 2026-27" lookup dataset (compiled by TaxToday from FBR tariff material and
 * the Finance Act 2026; https://taxtoday.pk/pakistan-hs-code-pct-code-search-online,
 * whose robots.txt explicitly allows /wp-admin/admin-ajax.php).
 * The data is provided "as published" and must be re-verified against the
 * operative FBR tariff before any legal/tax decision.
 *
 * The script is idempotent: rows are matched by hsCode and updated in place.
 * Existing rows are never deleted (invoice items may reference them).
 *
 * Usage: node scripts/seed-fbr-hs-codes.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import prisma from '../src/db/prisma.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(here, '..', 'prisma', 'data', 'pct-hs-codes.json');
const HS_CODE_PATTERN = /^\d{4}\.\d{4}$/;

/** Decode the handful of HTML entities present in the tariff export. */
function decodeEntities(text) {
    return text
        .replace(/&#0?39;|&#x27;/gi, "'")
        .replace(/&#0?8217;|&#x2019;/gi, '\u2019')
        .replace(/&quot;|&#0?34;|&#x22;/gi, '"')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

/** Strip tariff-book indentation dashes, decode entities, collapse whitespace. */
function normalizeDescription(raw) {
    return decodeEntities(String(raw ?? '')
        .replace(/^(?:\s*-\s*)+/, '')
        .replace(/\s+/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function loadCodes() {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('Expected an array of HS code rows');

    const byCode = new Map();
    const skipped = [];
    for (const row of raw) {
        const code = String(row?.pctCode ?? '').trim();
        const description = normalizeDescription(row?.description);
        if (!HS_CODE_PATTERN.test(code) || !description) {
            skipped.push({ code, description });
            continue;
        }
        byCode.set(code, description); // last one wins; file is already deduped
    }
    return { rows: [...byCode.entries()], skipped };
}

async function main() {
    const { rows, skipped } = loadCodes();
    console.log(`Loaded ${rows.length} unique HS codes from ${path.basename(DATA_FILE)} (skipped ${skipped.length} invalid rows)`);

    const existing = await prisma.fbrHsCode.findMany({ select: { hsCode: true, description: true } });
    const existingByCode = new Map(existing.map((row) => [row.hsCode, row.description]));

    const toCreate = [];
    const toUpdate = [];
    for (const [hsCode, description] of rows) {
        if (!existingByCode.has(hsCode)) toCreate.push({ hsCode, description });
        else if (existingByCode.get(hsCode) !== description) toUpdate.push({ hsCode, description });
    }

    let created = 0;
    let updated = 0;

    // createMany in batches keeps this fast on SQL Server.
    for (let i = 0; i < toCreate.length; i += 500) {
        const batch = toCreate.slice(i, i + 500);
        const result = await prisma.fbrHsCode.createMany({ data: batch });
        created += result.count;
    }

    for (const row of toUpdate) {
        await prisma.fbrHsCode.update({ where: { hsCode: row.hsCode }, data: { description: row.description } });
        updated += 1;
    }

    const total = await prisma.fbrHsCode.count();
    console.log(`Done. created=${created} updated=${updated} unchanged=${rows.length - toCreate.length - toUpdate.length} tableTotal=${total}`);
    if (skipped.length > 0) {
        console.warn('Skipped rows (invalid format or empty description):');
        for (const row of skipped.slice(0, 10)) console.warn(' ', JSON.stringify(row));
    }
}

main()
    .catch((error) => {
        console.error('HS code seed failed:', error?.message ?? error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
