/**
 * Fetches the public PCT/HS code reference dataset used by the TaxToday
 * lookup tool (compiled from Pakistan Customs Tariff / FBR publications,
 * FY 2026-27). The endpoint is explicitly allowed in robots.txt
 * (Allow: /wp-admin/admin-ajax.php).
 *
 * Output: prisma/data/pct-hs-codes.json — [{ pctCode, description, cdRate, fiscalYear }]
 * Run scripts/seed-fbr-hs-codes.mjs afterwards to load it into FbrHsCode.
 * The PHL_NONCE from the lookup page is session-scoped; if the endpoint
 * rejects requests, grab a fresh nonce and pass it as PHL_NONCE.
 */
import { writeFileSync } from 'node:fs';

const AJAX_URL = 'https://taxtoday.pk/wp-admin/admin-ajax.php';
const NONCE = process.env.PHL_NONCE || '37325f9467';
const PER_PAGE = 100;

async function fetchPage(offset) {
  const body = new URLSearchParams({
    action: 'phl_search',
    nonce: NONCE,
    query: '',
    chapter: '',
    cd_rate: '',
    fiscal_year: '',
    import_value: '0',
    per_page: String(PER_PAGE),
    offset: String(offset),
  });
  const response = await fetch(AJAX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} at offset ${offset}`);
  const json = await response.json();
  if (!json?.success) throw new Error(`API rejected offset ${offset}: ${JSON.stringify(json)}`);
  return json.data;
}

const first = await fetchPage(0);
const total = first.total;
console.log(`Total rows reported: ${total}, page size: ${PER_PAGE}`);

const byCode = new Map();
const add = (rows) => {
  for (const row of rows ?? []) {
    const code = String(row.pct_code ?? '').trim();
    const description = String(row.description ?? '').replace(/\s+/g, ' ').trim();
    if (!/^\d{4}\.\d{4}$/.test(code) || !description) continue;
    byCode.set(code, {
      pctCode: code,
      description,
      cdRate: row.cd_rate ?? null,
      fiscalYear: row.fiscal_year ?? '',
    });
  }
};
add(first.items);
for (let offset = PER_PAGE; offset < total; offset += PER_PAGE) {
  const page = await fetchPage(offset);
  add(page.items);
  if ((offset / PER_PAGE) % 10 === 0) console.log(`fetched ${offset + (page.items?.length ?? 0)} / ${total}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const all = [...byCode.values()].sort((a, b) => a.pctCode.localeCompare(b.pctCode, 'en', { numeric: true }));
writeFileSync('prisma/data/pct-hs-codes.json', JSON.stringify(all, null, 2));
console.log(`Saved ${all.length} unique HS codes to prisma/data/pct-hs-codes.json`);
