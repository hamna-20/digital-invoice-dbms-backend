/**
 * Development-only demo products with sample tax rates.
 *
 * Usage (PowerShell):
 *   npm run seed:demo -- --email you@example.test
 *   # or
 *   $env:DEMO_SEED_EMAIL="you@example.test"; npm run seed:demo
 *
 * IMPORTANT
 *   - These rates are SAMPLE VALUES for development/testing only.
 *   - They are not official FBR rates and must not be presented as such.
 *   - Existing products are never updated. If a demo code already exists for
 *     the user, it is skipped so user-configured prices/rates are preserved.
 *   - Issued invoices keep their InvoiceItem taxRate snapshots when a product
 *     rate is later changed, so this seed is safe for historical data.
 */
import prisma from '../src/db/prisma.js';

const SAMPLES = [
    {
        code: 'DEMO-TAX-0',
        name: 'Demo Zero-Rated Item (Sample)',
        description: 'Sample development data. Sample tax rate 0%; not an official FBR rate.',
        price: 100,
        taxRate: 0,
        stockQuantity: 50,
    },
    {
        code: 'DEMO-TAX-5',
        name: 'Demo Reduced-Rate Item (Sample)',
        description: 'Sample development data. Sample tax rate 5%; not an official FBR rate.',
        price: 250,
        taxRate: 5,
        stockQuantity: 50,
    },
    {
        code: 'DEMO-TAX-17',
        name: 'Demo Standard-Rate Item A (Sample)',
        description: 'Sample development data. Sample tax rate 17%; not an official FBR rate.',
        price: 500,
        taxRate: 17,
        stockQuantity: 50,
    },
    {
        code: 'DEMO-TAX-18',
        name: 'Demo Standard-Rate Item B (Sample)',
        description: 'Sample development data. Sample tax rate 18%; not an official FBR rate.',
        price: 750,
        taxRate: 18,
        stockQuantity: 50,
    },
];

function readEmail() {
    const index = process.argv.indexOf('--email');
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    const inline = process.argv.find((argument) => argument.startsWith('--email='));
    if (inline) return inline.slice('--email='.length);
    return process.env.DEMO_SEED_EMAIL;
}

async function main() {
    const rawEmail = readEmail();
    if (!rawEmail || !rawEmail.trim()) {
        console.error('Usage: npm run seed:demo -- --email you@example.test');
        console.error('   or: $env:DEMO_SEED_EMAIL="you@example.test"; npm run seed:demo');
        process.exitCode = 1;
        return;
    }

    const email = rawEmail.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });

    if (!user) {
        console.error(`No user found for ${email}. Sign up first, then run the seed.`);
        process.exitCode = 1;
        return;
    }

    console.log('============================================================');
    console.log('DEMO DATA ONLY - sample tax rates for development/testing.');
    console.log('These are NOT official FBR rates and are not tax advice.');
    console.log('Existing products/rates are never modified.');
    console.log(`Target user: ${user.email} (id=${user.id})`);
    console.log('============================================================');

    let created = 0;
    let skipped = 0;

    for (const sample of SAMPLES) {
        const existing = await prisma.product.findUnique({
            where: { userId_code: { userId: user.id, code: sample.code } },
            select: { id: true, price: true, taxRate: true },
        });

        if (existing) {
            skipped += 1;
            console.log(
                `SKIP  ${sample.code} - already exists (price ${existing.price}, tax ${existing.taxRate}%) - not modified`
            );
            continue;
        }

        const product = await prisma.product.create({
            data: {
                userId: user.id,
                ...sample,
            },
            select: { id: true, code: true, taxRate: true },
        });
        created += 1;
        console.log(`CREATE ${product.code} (id=${product.id}) sample tax rate ${product.taxRate}%`);
    }

    console.log(`\nDone: ${created} created, ${skipped} skipped.`);
    console.log('Sample rates: 0%, 5%, 17%, 18%. Replace them with confirmed rates in the product form.');
}

main()
    .catch((error) => {
        console.error('Demo seed failed:', error?.message ?? error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
