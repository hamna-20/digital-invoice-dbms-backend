/**
 * End-to-end tests for the return and customer-credit settlement model.
 * Requires a running API and SQL Server database.
 *
 * Run with: node test/return-settlement.e2e.mjs
 *
 * Scenarios:
 *   1. Customer + product (stock 10) + invoice qty 2, issued (stock -> 8).
 *   2. Payment with credit: paid must exceed unpaid (CONFIRM 1). Credit is
 *      issued from excess cash only; the invoice becomes paid and the customer
 *      balance rises by the credit.
 *   3. Approving a saleable return restocks once, claws back issued credit
 *      (capped at the available balance), reduces unpaid, and sends the
 *      leftover to "return_credit". No negative customer balance.
 *   4. Approving the same return twice returns 409.
 *   5. Returning more than sold returns 409.
 *   6. Rejecting without a reason returns 400.
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const ownerEmail = `test.returnsettle.${stamp}@example.test`;
const productCode = String(stamp % 1_000_000).padStart(6, '0');
const today = new Date().toISOString().slice(0, 10);
const results = [];
let ownerId;

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

/** Paisa-safe comparison of two money values. */
const money = (value) => Math.round((Number(value) || 0) * 100);

async function run() {
    let token;
    let customer;
    let product;
    let invoiceId;
    let firstPaymentId;
    let returnOneId;
    let unpaidInvoiceId;
    let unpaidReturnId;

    try {
        // ------------------------------------------------------------- setup
        const signup = await request('POST', '/api/auth/signup', {
            body: {
                fullName: 'Return Settlement Test',
                email: ownerEmail,
                password,
                confirmPassword: password,
            },
        });
        ownerId = signup.json?.data?.user?.id;
        check('test user signed up', signup.status === 201, `status=${signup.status}`);

        const signin = await request('POST', '/api/auth/signin', {
            body: { email: ownerEmail, password },
        });
        token = signin.json?.data?.token;
        check('test user signed in', signin.status === 200 && Boolean(token));
        if (!token) throw new Error('No access token; cannot continue');

        // 1. Customer, product with stock 10, invoice qty 2, issued.
        const customerResponse = await request('POST', '/api/customers', {
            token,
            body: { name: `Settlement Customer ${stamp}`, email: `settle.customer.${stamp}@example.test` },
        });
        customer = customerResponse.json?.data?.customer;
        check('customer created', customerResponse.status === 201 && Number.isSafeInteger(customer?.id));

        const productResponse = await request('POST', '/api/products', {
            token,
            body: { name: 'Settlement Widget', code: productCode, price: 500, taxRate: 0, stockQuantity: 10 },
        });
        product = productResponse.json?.data?.product;
        check('product created with stock 10', productResponse.status === 201 && product?.stockQuantity === 10);

        const invoiceResponse = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: product.id, quantity: 2 }],
            },
        });
        invoiceId = invoiceResponse.json?.data?.invoice?.id;
        check('draft invoice of total 1000 created',
            invoiceResponse.status === 201 && money(invoiceResponse.json?.data?.invoice?.grandTotal) === 100000);

        const issued = await request('PATCH', `/api/invoices/${invoiceId}/issue`, { token });
        check('invoice issued',
            issued.status === 200 && issued.json?.data?.invoice?.status === 'issued',
            `status=${issued.status}`);

        const stockAfterIssue = await request('GET', `/api/products/${product.id}`, { token });
        check('issuing decrements stock to 8', stockAfterIssue.json?.data?.product?.stockQuantity === 8);

        // 2. Payments: credit only ever comes from excess cash.
        const creditNoExcess = await request('POST', `/api/invoices/${invoiceId}/payments`, {
            token,
            body: {
                amount: '500.00',
                creditAmount: '200.00',
                creditReason: 'Goodwill credit',
                paymentDate: today,
                expectedVersion: issued.json?.data?.invoice?.version,
                idempotencyKey: `key-noexcess-${stamp}`,
            },
        });
        check('credit without excess cash is refused (paid 500 < unpaid 1000)',
            creditNoExcess.status === 409, `status=${creditNoExcess.status} msg=${creditNoExcess.json?.error?.message ?? ''}`);

        const partial = await request('POST', `/api/invoices/${invoiceId}/payments`, {
            token,
            body: { amount: '500.00', paymentDate: today, idempotencyKey: `key-partial-${stamp}` },
        });
        firstPaymentId = partial.json?.data?.invoice?.payments?.[0]?.id ?? null;
        check('partial payment of 500 leaves unpaid 500',
            partial.status === 201 &&
            partial.json?.data?.invoice?.status === 'partially_paid' &&
            money(partial.json?.data?.invoice?.financialSummary?.unpaid) === 50000,
            `status=${partial.status} unpaid=${partial.json?.data?.invoice?.financialSummary?.unpaid}`);

        // paid 700 > unpaid 500: excess 200 may be issued as credit.
        const withCredit = await request('POST', `/api/invoices/${invoiceId}/payments`, {
            token,
            body: {
                amount: '700.00',
                creditAmount: '200.00',
                creditReason: 'Advance on account',
                paymentDate: today,
                idempotencyKey: `key-credit-${stamp}`,
            },
        });
        const creditInvoice = withCredit.json?.data?.invoice;
        check('paid 700 + credit 200 settles the invoice and issues 200 credit',
            withCredit.status === 201 &&
            money(creditInvoice?.financialSummary?.creditIssued) === 20000 &&
            money(creditInvoice?.financialSummary?.unpaid) === 0 &&
            creditInvoice?.status === 'paid',
            `status=${withCredit.status} creditIssued=${creditInvoice?.financialSummary?.creditIssued} unpaid=${creditInvoice?.financialSummary?.unpaid}`);
        check('invoice carries the credit badge alongside paid',
            (creditInvoice?.statuses || []).includes('credit') && (creditInvoice?.statuses || []).includes('paid'),
            `statuses=${JSON.stringify(creditInvoice?.statuses)}`);

        // The same idempotency key replays the first result and writes nothing.
        const replay = await request('POST', `/api/invoices/${invoiceId}/payments`, {
            token,
            body: {
                amount: '700.00',
                creditAmount: '200.00',
                creditReason: 'Advance on account',
                paymentDate: today,
                idempotencyKey: `key-credit-${stamp}`,
            },
        });
        const replayLedger = await request('GET', `/api/customers/${customer.id}/credit`, { token });
        check('replayed payment key returns replayed=true and issues no extra credit',
            replay.status === 200 && replay.json?.data?.replayed === true &&
            money(replayLedger.json?.data?.available) === 20000,
            `status=${replay.status} replayed=${replay.json?.data?.replayed} available=${replayLedger.json?.data?.available}`);

        // 3. Return of 1 unit (saleable), approved: restock once + settlement.
        const returnResponse = await request('POST', `/api/invoices/${invoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'One unit returned in saleable condition',
                items: [{ invoiceItemId: creditInvoice?.items?.[0]?.id, quantity: 1, disposition: 'saleable' }],
            },
        });
        returnOneId = returnResponse.json?.data?.return?.id;
        check('return of 1 unit created as pending (no stock or money moved yet)',
            returnResponse.status === 201 && returnResponse.json?.data?.return?.status === 'pending' &&
            money(returnResponse.json?.data?.return?.totalAmount) === 50000);

        const stockBeforeApproval = await request('GET', `/api/products/${product.id}`, { token });
        const approved = await request('PATCH', `/api/invoices/${invoiceId}/returns/${returnOneId}/approve`, { token });
        const approvedInvoice = approved.json?.data?.invoice;
        check('return approved with a RET- number',
            approved.status === 200 && /^RET-\d+$/.test(approved.json?.data?.return?.returnNumber || ''),
            `status=${approved.status}`);

        const stockAfterApproval = await request('GET', `/api/products/${product.id}`, { token });
        check('saleable return restocks the product (8 -> 9)',
            stockBeforeApproval.json?.data?.product?.stockQuantity === 8 &&
            stockAfterApproval.json?.data?.product?.stockQuantity === 9,
            `before=${stockBeforeApproval.json?.data?.product?.stockQuantity} after=${stockAfterApproval.json?.data?.product?.stockQuantity}`);

        // Waterfall: clawback = min(return 500, C 200, available 200) = 200.
        // Unpaid was already 0, so no unpaid reduction. Leftover 300 -> return_credit.
        const creditAfterReturn = await request('GET', `/api/customers/${customer.id}/credit`, { token });
        check('approval claws back the 200 issued credit and credits 300 return credit',
            money(creditAfterReturn.json?.data?.available) === 30000,
            `available=${creditAfterReturn.json?.data?.available}`);
        check('customer balance never goes negative',
            money(creditAfterReturn.json?.data?.available) >= 0);
        check('return credit is customer money, not invoice money (unpaid stays 0)',
            money(approvedInvoice?.financialSummary?.unpaid) === 0 &&
            money(approvedInvoice?.financialSummary?.returnCredit) === 30000,
            `unpaid=${approvedInvoice?.financialSummary?.unpaid} returnCredit=${approvedInvoice?.financialSummary?.returnCredit}`);
        check('invoice keeps the credit and return badges after approval',
            (approvedInvoice?.statuses || []).includes('credit') && (approvedInvoice?.statuses || []).includes('return'),
            `statuses=${JSON.stringify(approvedInvoice?.statuses)}`);

        // 4. The same return cannot be approved twice.
        const approveTwice = await request('PATCH', `/api/invoices/${invoiceId}/returns/${returnOneId}/approve`, { token });
        check('approving the same return twice returns 409', approveTwice.status === 409, `status=${approveTwice.status}`);

        // Unpaid-reduction path: a second invoice paid only partially.
        const unpaidDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: product.id, quantity: 2 }],
            },
        });
        unpaidInvoiceId = unpaidDraft.json?.data?.invoice?.id;
        await request('PATCH', `/api/invoices/${unpaidInvoiceId}/issue`, { token });
        const unpaidPayment = await request('POST', `/api/invoices/${unpaidInvoiceId}/payments`, {
            token,
            body: { amount: '400.00', paymentDate: today, idempotencyKey: `key-unpaid-${stamp}` },
        });
        check('second invoice partially paid (unpaid 600)',
            unpaidPayment.status === 201 &&
            money(unpaidPayment.json?.data?.invoice?.financialSummary?.unpaid) === 60000,
            `unpaid=${unpaidPayment.json?.data?.invoice?.financialSummary?.unpaid}`);

        const unpaidReturn = await request('POST', `/api/invoices/${unpaidInvoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'Saleable return against an open balance',
                items: [{ invoiceItemId: unpaidPayment.json?.data?.invoice?.items?.[0]?.id, quantity: 1, disposition: 'saleable' }],
            },
        });
        unpaidReturnId = unpaidReturn.json?.data?.return?.id;
        const unpaidApproved = await request('PATCH', `/api/invoices/${unpaidInvoiceId}/returns/${unpaidReturnId}/approve`, { token });
        const unpaidSettled = unpaidApproved.json?.data?.invoice;
        check('return value reduces the unpaid balance (600 -> 100)',
            unpaidApproved.status === 200 && money(unpaidSettled?.financialSummary?.unpaid) === 10000,
            `unpaid=${unpaidSettled?.financialSummary?.unpaid}`);
        check('no return credit is created when the value fits the unpaid balance',
            money(unpaidSettled?.financialSummary?.returnCredit) === 0,
            `returnCredit=${unpaidSettled?.financialSummary?.returnCredit}`);

        // 5. Returning more than sold is refused. 2 invoiced, 1 already approved.
        const overReturn = await request('POST', `/api/invoices/${unpaidInvoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'Exceeds remaining sold quantity',
                items: [{ invoiceItemId: unpaidPayment.json?.data?.invoice?.items?.[0]?.id, quantity: 2, disposition: 'saleable' }],
            },
        });
        check('returning more than sold returns 409', overReturn.status === 409, `status=${overReturn.status}`);

        // 6. Rejecting without a reason is refused with 400.
        const pendingReturn = await request('POST', `/api/invoices/${unpaidInvoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'Will be rejected without a reason',
                items: [{ invoiceItemId: unpaidPayment.json?.data?.invoice?.items?.[0]?.id, quantity: 1, disposition: 'unsaleable' }],
            },
        });
        const pendingId = pendingReturn.json?.data?.return?.id;
        const rejectNoReason = await request('PATCH', `/api/invoices/${unpaidInvoiceId}/returns/${pendingId}/reject`, {
            token,
            body: {},
        });
        check('rejecting a return without a reason returns 400',
            rejectNoReason.status === 400, `status=${rejectNoReason.status}`);
        const rejectWithReason = await request('PATCH', `/api/invoices/${unpaidInvoiceId}/returns/${pendingId}/reject`, {
            token,
            body: { reason: 'Damaged beyond resale' },
        });
        check('rejecting with a reason succeeds and settles nothing',
            rejectWithReason.status === 200 && rejectWithReason.json?.data?.return?.status === 'rejected');
    } finally {
        if (Number.isSafeInteger(ownerId)) {
            await prisma.auditLog.deleteMany({ where: { userId: ownerId } }).catch(() => {});
            await prisma.creditNote.deleteMany({ where: { invoice: { userId: ownerId } } }).catch(() => {});
            await prisma.creditApplication.deleteMany({ where: { customer: { userId: ownerId } } }).catch(() => {});
            await prisma.customerCreditEntry.deleteMany({ where: { customer: { userId: ownerId } } }).catch(() => {});
            await prisma.returnCredit.deleteMany({ where: { invoice: { userId: ownerId } } }).catch(() => {});
            await prisma.invoiceReturn.deleteMany({ where: { invoice: { userId: ownerId } } }).catch(() => {});
            await prisma.payment.deleteMany({ where: { invoice: { userId: ownerId } } }).catch(() => {});
            await prisma.invoiceActivity.deleteMany({ where: { invoice: { userId: ownerId } } }).catch(() => {});
            await prisma.stockMovement.deleteMany({ where: { product: { userId: ownerId } } }).catch(() => {});
            await prisma.invoice.deleteMany({ where: { userId: ownerId } }).catch(() => {});
            await prisma.product.deleteMany({ where: { userId: ownerId } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId: ownerId } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nReturn settlement tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nReturn settlement test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
