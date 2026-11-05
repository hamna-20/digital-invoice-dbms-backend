/**
 * End-to-end tests for the internal FBR/PRAL-style mock workflow.
 *
 * Requires a running API and SQL Server database:
 *   node test/fbr-mock.e2e.mjs
 *
 * No FBR/PRAL endpoint, token or credential is used anywhere in this test.
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const email = `test.fbrmock.${stamp}@example.test`;
const productCode = String(stamp % 1_000_000).padStart(6, '0');
const today = new Date().toISOString().slice(0, 10);
const results = [];
let userId;

function check(name, condition, detail = '') {
    const passed = Boolean(condition);
    results.push({ name, passed });
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function request(method, path, { body, token } = {}) {
    const headers = {};
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${BASE}${path}`, init);
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // 204 responses have no body.
    }
    return { status: response.status, json };
}

const errorsFor = (response) => response.json?.errors ?? [];
const hasSource = (errors, source) => errors.some((entry) => entry.source === source);

async function run() {
    let token;
    let customer;
    let product;
    let invoice;

    try {
        const signup = await request('POST', '/api/auth/signup', {
            body: { fullName: 'FBR Mock Test', email, password, confirmPassword: password },
        });
        userId = signup.json?.data?.user?.id;
        check('test user signed up', signup.status === 201, `status=${signup.status}`);

        const signin = await request('POST', '/api/auth/signin', { body: { email, password } });
        token = signin.json?.data?.token;
        check('test user signed in', signin.status === 200 && Boolean(token));
        if (!token) throw new Error('No access token; cannot continue');

        // Deliberately incomplete fixtures: seller profile absent, buyer has
        // no registration/province/address, product has no HS/UoM/sale type.
        customer = (
            await request('POST', '/api/customers', {
                token,
                body: { name: `FBR Buyer ${stamp}` },
            })
        ).json?.data?.customer;
        product = (
            await request('POST', '/api/products', {
                token,
                body: { name: 'FBR Widget', code: productCode, price: 100, taxRate: 17, stockQuantity: 10 },
            })
        ).json?.data?.product;
        check('incomplete fixtures created', Boolean(customer?.id && product?.id));

        invoice = (
            await request('POST', '/api/invoices', {
                token,
                body: {
                    customerId: customer.id,
                    invoiceDate: today,
                    items: [{ productId: product.id, quantity: 2 }],
                },
            })
        ).json?.data?.invoice;
        check('draft invoice created', Boolean(invoice?.id));

        // 1. Draft readiness is read-only and lists every exact source.
        const draftReadiness = await request('GET', `/api/invoices/${invoice.id}/fbr`, { token });
        check(
            'draft readiness is readable but not ready',
            draftReadiness.status === 200 &&
                draftReadiness.json?.data?.ready === false &&
                draftReadiness.json?.data?.invoiceStatus === 'draft',
            `status=${draftReadiness.status}`
        );
        check(
            'readiness errors name Seller, Customer, Invoice and Product',
            ['Seller', 'Customer', 'Product'].every((source) =>
                hasSource(draftReadiness.json?.data?.errors ?? [], source)
            )
        );
        check(
            'readiness errors name the exact fields',
            ['seller.ntn', 'customer.province', 'items[0].hsCode', 'items[0].uom'].every((field) =>
                (draftReadiness.json?.data?.errors ?? []).some((entry) => entry.field === field)
            )
        );
        check(
            'readiness never claims FBR acceptance',
            draftReadiness.json?.data?.statusLabel === 'Not Submitted to FBR' &&
                String(draftReadiness.json?.data?.disclaimer).includes('FBR invoicing workflow')
        );

        // 2. Issuing is blocked by the authoritative validator; nothing moves.
        const stockBefore = (
            await request('GET', `/api/products/${product.id}`, { token })
        ).json?.data?.product?.stockQuantity;
        const blockedIssue = await request('PATCH', `/api/invoices/${invoice.id}/issue`, { token });
        check(
            'incomplete invoice cannot be issued',
            blockedIssue.status === 400 && hasSource(errorsFor(blockedIssue), 'Seller'),
            `status=${blockedIssue.status}`
        );
        const afterBlocked = await request('GET', `/api/invoices/${invoice.id}`, { token });
        const stockAfterBlocked = (
            await request('GET', `/api/products/${product.id}`, { token })
        ).json?.data?.product?.stockQuantity;
        check(
            'blocked issue leaves the draft and stock unchanged',
            afterBlocked.json?.data?.invoice?.status === 'draft' && stockAfterBlocked === stockBefore
        );

        // 3. Validation and submission on a draft are rejected by state, not by payload.
        const draftValidate = await request('POST', `/api/invoices/${invoice.id}/fbr/validate`, { token });
        const draftSubmit = await request('POST', `/api/invoices/${invoice.id}/fbr/submit`, { token });
        check(
            'validation and submission require a fully paid invoice',
            draftValidate.status === 409 && draftSubmit.status === 409,
            `validate=${draftValidate.status} submit=${draftSubmit.status}`
        );

        // 4. Complete the seller, buyer and product configuration.
        const seller = await request('PUT', '/api/seller', {
            token,
            body: {
                businessName: 'FBR Mock Seller',
                ntn: '7654321-0',
                province: 'Punjab',
                address: 'Mock Seller Address, Lahore',
            },
        });
        check('seller profile saved', seller.status === 200, `status=${seller.status}`);

        const buyer = await request('PUT', `/api/customers/${customer.id}`, {
            token,
            body: {
                name: customer.name,
                registration: 'Unregistered',
                province: 'Sindh',
                address: 'Mock Buyer Address, Karachi',
            },
        });
        check('buyer configuration saved', buyer.status === 200, `status=${buyer.status}`);

        const configuredProduct = await request('PUT', `/api/products/${product.id}`, {
            token,
            body: { unit: 'PCS', hsCode: '8471.3000', saleType: 'Taxable' },
        });
        check('product configuration saved', configuredProduct.status === 200, `status=${configuredProduct.status}`);

        // The draft's line snapshot was taken at create time, so re-save the
        // items to pick up the newly configured product fields.
        const refreshedDraft = await request('PUT', `/api/invoices/${invoice.id}`, {
            token,
            body: { items: [{ productId: product.id, quantity: 2 }] },
        });
        check('draft line snapshot refreshed', refreshedDraft.status === 200, `status=${refreshedDraft.status}`);

        const ready = await request('GET', `/api/invoices/${invoice.id}/fbr`, { token });
        check(
            'completed data makes the draft ready',
            ready.status === 200 && ready.json?.data?.ready === true,
            `status=${ready.status} errors=${JSON.stringify(ready.json?.data?.errors)}`
        );
        check(
            'payload uses PRAL-style field names',
            ready.json?.data?.payload?.sellerNTNCNIC === '7654321-0' &&
                ready.json?.data?.payload?.buyerProvince === 'Sindh' &&
                ready.json?.data?.payload?.items?.[0]?.hsCode === '8471.3000' &&
                ready.json?.data?.payload?.items?.[0]?.uoM === 'PCS' &&
                ready.json?.data?.payload?.mockOnly === true,
            `seller=${ready.json?.data?.payload?.sellerNTNCNIC} province=${ready.json?.data?.payload?.buyerProvince} hs=${ready.json?.data?.payload?.items?.[0]?.hsCode} uom=${ready.json?.data?.payload?.items?.[0]?.uoM} mockOnly=${ready.json?.data?.payload?.mockOnly}`
        );

        // 5. Issue, then mock validate and submit.
        const issued = await request('PATCH', `/api/invoices/${invoice.id}/issue`, { token });
        check(
            'complete invoice can be issued',
            issued.status === 200 && issued.json?.data?.invoice?.status === 'issued',
            `status=${issued.status}`
        );
        const stockAfterIssue = (
            await request('GET', `/api/products/${product.id}`, { token })
        ).json?.data?.product?.stockQuantity;
        check('issuing still decrements stock', stockAfterIssue === 8, `stock=${stockAfterIssue}`);

        const afterIssue = await request('GET', `/api/invoices/${invoice.id}/fbr`, { token });
        check(
            'issued invoice stores a frozen snapshot',
            afterIssue.json?.data?.fromIssueSnapshot === true &&
                afterIssue.json?.data?.snapshot?.sellerNTNCNIC === '7654321-0' &&
                afterIssue.json?.data?.statusLabel === 'Not Submitted to FBR'
        );
        check(
            'issued but unpaid invoice is not FBR eligible',
            afterIssue.json?.data?.invoiceStatus === 'issued' &&
                afterIssue.json?.data?.eligible === false,
            `invoiceStatus=${afterIssue.json?.data?.invoiceStatus} eligible=${afterIssue.json?.data?.eligible}`
        );

        // 4b. An issued invoice still cannot be validated or submitted until paid.
        const unpaidValidate = await request('POST', `/api/invoices/${invoice.id}/fbr/validate`, { token });
        const unpaidSubmit = await request('POST', `/api/invoices/${invoice.id}/fbr/submit`, { token });
        check(
            'issued but unpaid invoice cannot be validated or submitted',
            unpaidValidate.status === 409 &&
                unpaidSubmit.status === 409 &&
                String(unpaidValidate.json?.message).includes('fully paid') &&
                String(unpaidSubmit.json?.message).includes('fully paid'),
            `validate=${unpaidValidate.status} submit=${unpaidSubmit.status}`
        );

        // 4c. Fully paying the invoice makes it eligible for mandatory FBR submission.
        const paid = await request('PATCH', `/api/invoices/${invoice.id}/pay`, { token });
        check(
            'invoice is fully paid before FBR submission',
            paid.status === 200 && paid.json?.data?.invoice?.status === 'paid',
            `status=${paid.status} invoiceStatus=${paid.json?.data?.invoice?.status}`
        );
        const afterPaid = await request('GET', `/api/invoices/${invoice.id}/fbr`, { token });
        check(
            'paid invoice is FBR eligible and mandatory',
            afterPaid.json?.data?.invoiceStatus === 'paid' &&
                afterPaid.json?.data?.eligible === true &&
                afterPaid.json?.data?.mandatory === true,
            `invoiceStatus=${afterPaid.json?.data?.invoiceStatus} eligible=${afterPaid.json?.data?.eligible}`
        );

        const validated = await request('POST', `/api/invoices/${invoice.id}/fbr/validate`, { token });
        check(
            'validation returns a reference and Validated status',
            validated.status === 200 &&
                validated.json?.data?.status === 'mock_validated' &&
                validated.json?.data?.statusLabel === 'Validated' &&
                String(validated.json?.data?.reference).startsWith('FBR-'),
            `status=${validated.status}`
        );

        const submitted = await request('POST', `/api/invoices/${invoice.id}/fbr/submit`, { token });
        check(
            'submission records Submitted with a timestamp',
            submitted.status === 200 &&
                submitted.json?.data?.status === 'mock_submitted' &&
                submitted.json?.data?.statusLabel === 'Submitted' &&
                Boolean(submitted.json?.data?.submission?.submittedAt),
            `status=${submitted.status}`
        );
        check(
            'submission response records the submission',
            String(submitted.json?.message).includes('Submission recorded') &&
                String(submitted.json?.data?.disclaimer).includes('FBR invoicing workflow')
        );

        const invoiceWithFbr = await request('GET', `/api/invoices/${invoice.id}`, { token });
        check(
            'invoice detail carries the FBR status summary',
            invoiceWithFbr.json?.data?.invoice?.fbr?.statusLabel === 'Submitted' &&
                String(invoiceWithFbr.json?.data?.invoice?.fbr?.reference).startsWith('FBR-')
        );

        // 6. Later product/customer edits must not rewrite the issued snapshot.
        await request('PUT', `/api/products/${product.id}`, {
            token,
            body: { name: 'Renamed After Issue', hsCode: '9999.9999', unit: 'KG' },
        });
        await request('PUT', `/api/customers/${customer.id}`, {
            token,
            body: { name: 'Renamed Buyer After Issue', province: 'Balochistan', address: 'Changed Address' },
        });

        const frozen = await request('GET', `/api/invoices/${invoice.id}/fbr`, { token });
        check(
            'issued FBR snapshot survives product and customer edits',
            frozen.json?.data?.payload?.items?.[0]?.productDescription === 'FBR Widget' &&
                frozen.json?.data?.payload?.items?.[0]?.hsCode === '8471.3000' &&
                frozen.json?.data?.payload?.buyerProvince === 'Sindh' &&
                frozen.json?.data?.payload?.buyerAddress === 'Mock Buyer Address, Karachi'
        );

        // 7. A Registered buyer without an NTN/CNIC is blocked with an exact error.
        const registeredDraft = (
            await request('POST', '/api/invoices', {
                token,
                body: {
                    customerId: customer.id,
                    invoiceDate: today,
                    items: [{ productId: product.id, quantity: 1 }],
                },
            })
        ).json?.data?.invoice;
        await request('PUT', `/api/customers/${customer.id}`, {
            token,
            body: { registration: 'Registered' },
        });
        const registeredIssue = await request('PATCH', `/api/invoices/${registeredDraft.id}/issue`, { token });
        check(
            'Registered buyer without NTN/CNIC is blocked by field',
            registeredIssue.status === 400 &&
                errorsFor(registeredIssue).some(
                    (entry) => entry.field === 'customer.taxNumber' && entry.source === 'Customer'
                ),
            `status=${registeredIssue.status}`
        );

        // 8. Third Schedule goods must carry the published FBR sale type and the
        // fixed/notified retail price in both the readiness payload and snapshot.
        await request('PUT', `/api/customers/${customer.id}`, {
            token,
            body: { registration: 'Unregistered' },
        });

        const thirdProductCode = String((stamp + 1) % 1_000_000).padStart(6, '0');
        const thirdProduct = (
            await request('POST', '/api/products', {
                token,
                body: {
                    name: 'Third Schedule Widget',
                    code: thirdProductCode,
                    price: 100,
                    retailPrice: 150,
                    taxRate: 18,
                    stockQuantity: 5,
                    hsCode: '8471.3000',
                    unit: 'PCS',
                    saleType: 'Third Schedule',
                },
            })
        ).json?.data?.product;
        check(
            'Third Schedule product saves the retail price',
            thirdProduct?.retailPrice === 150,
            `retailPrice=${thirdProduct?.retailPrice}`
        );

        const thirdDraft = (
            await request('POST', '/api/invoices', {
                token,
                body: {
                    customerId: customer.id,
                    invoiceDate: today,
                    items: [{ productId: thirdProduct.id, quantity: 1 }],
                },
            })
        ).json?.data?.invoice;
        const thirdReady = await request('GET', `/api/invoices/${thirdDraft.id}/fbr`, { token });
        check(
            'Third Schedule payload uses the published FBR sale type and retail price',
            thirdReady.status === 200 &&
                thirdReady.json?.data?.ready === true &&
                thirdReady.json?.data?.payload?.items?.[0]?.saleType === '3rd Schedule Goods' &&
                thirdReady.json?.data?.payload?.items?.[0]?.fixedNotifiedValueOrRetailPrice === 150,
            `saleType=${thirdReady.json?.data?.payload?.items?.[0]?.saleType} retail=${thirdReady.json?.data?.payload?.items?.[0]?.fixedNotifiedValueOrRetailPrice}`
        );

        const thirdIssued = await request('PATCH', `/api/invoices/${thirdDraft.id}/issue`, { token });
        const thirdFrozen = await request('GET', `/api/invoices/${thirdDraft.id}/fbr`, { token });
        check(
            'issued Third Schedule invoice freezes the retail price at issue time',
            thirdIssued.status === 200 &&
                thirdFrozen.json?.data?.fromIssueSnapshot === true &&
                thirdFrozen.json?.data?.snapshot?.items?.[0]?.saleType === '3rd Schedule Goods' &&
                thirdFrozen.json?.data?.snapshot?.items?.[0]?.fixedNotifiedValueOrRetailPrice === 150
        );

        // A Third Schedule product without a retail price cannot be issued.
        const missingRetailCode = String((stamp + 2) % 1_000_000).padStart(6, '0');
        const missingRetail = (
            await request('POST', '/api/products', {
                token,
                body: {
                    name: 'Third Schedule Without Retail',
                    code: missingRetailCode,
                    price: 100,
                    taxRate: 18,
                    stockQuantity: 5,
                    hsCode: '8471.3000',
                    unit: 'PCS',
                    saleType: 'Third Schedule',
                },
            })
        ).json?.data?.product;
        const missingRetailDraft = (
            await request('POST', '/api/invoices', {
                token,
                body: {
                    customerId: customer.id,
                    invoiceDate: today,
                    items: [{ productId: missingRetail.id, quantity: 1 }],
                },
            })
        ).json?.data?.invoice;
        const missingRetailIssue = await request(
            'PATCH',
            `/api/invoices/${missingRetailDraft.id}/issue`,
            { token }
        );
        check(
            'Third Schedule without a retail price is blocked by field',
            missingRetailIssue.status === 400 &&
                errorsFor(missingRetailIssue).some(
                    (entry) => entry.field === 'items[0].retailPrice' && entry.source === 'Product'
                ),
            `status=${missingRetailIssue.status}`
        );
    } finally {
        if (Number.isSafeInteger(userId)) {
            await prisma.auditLog.deleteMany({ where: { userId } }).catch(() => {});
            await prisma.mockFbrSubmission.deleteMany({ where: { invoice: { userId } } }).catch(() => {});
            await prisma.invoiceActivity.deleteMany({ where: { invoice: { userId } } }).catch(() => {});
            await prisma.invoice.deleteMany({ where: { userId } }).catch(() => {});
            await prisma.product.deleteMany({ where: { userId } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId } }).catch(() => {});
            await prisma.businessProfile.deleteMany({ where: { userId } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nFBR mock API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nFBR mock API test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
