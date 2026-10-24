/**
 * End-to-end tests for GET /api/dashboard/summary.
 *
 * Requires a running API and SQL Server database:
 *   node test/dashboard.e2e.mjs
 *
 * Every assertion is derived from data created by this run. The dashboard
 * period is the current UTC month/year, so dates are computed at runtime.
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const ownerEmail = `test.dashboard.${stamp}@example.test`;
const otherEmail = `test.dashboard.other.${stamp}@example.test`;
const emptyEmail = `test.dashboard.empty.${stamp}@example.test`;
const currentOnlyEmail = `test.dashboard.current.${stamp}@example.test`;
const results = [];

let ownerId;
let otherId;
let emptyId;
let currentOnlyId;

const ymd = (date) => date.toISOString().slice(0, 10);
const dayOffset = (offset) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return date;
};

const today = new Date();
const currentYear = today.getUTCFullYear();
const currentMonthStart = new Date(Date.UTC(currentYear, today.getUTCMonth(), 1));
const currentMonthEnd = new Date(Date.UTC(currentYear, today.getUTCMonth() + 1, 0));
const previousMonthEnd = new Date(Date.UTC(currentYear, today.getUTCMonth(), 0));
const overdueInvoiceDate = dayOffset(-70);
const overdueDueDate = dayOffset(-5);

const currentMonthStartStr = ymd(currentMonthStart);
const currentMonthEndStr = ymd(currentMonthEnd);
const previousMonthEndStr = ymd(previousMonthEnd);
const overdueInvoiceDateStr = ymd(overdueInvoiceDate);
const overdueDueDateStr = ymd(overdueDueDate);

const previousInCurrentYear = previousMonthEnd.getUTCFullYear() === currentYear;
const overdueInCurrentYear = overdueInvoiceDate.getUTCFullYear() === currentYear;

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

async function createTestUser(address, isOwner) {
    const signup = await request('POST', '/api/auth/signup', {
        body: {
            fullName: 'Dashboard API Test',
            email: address,
            password,
            confirmPassword: password,
        },
    });
    check(`signup dashboard user (${isOwner})`, signup.status === 201, `status=${signup.status}`);
    const id = signup.json?.data?.user?.id;
    if (Number.isSafeInteger(id)) {
        if (isOwner === 'owner') ownerId = id;
        else if (isOwner === 'other') otherId = id;
        else if (isOwner === 'empty') emptyId = id;
        else currentOnlyId = id;
    }

    const signin = await request('POST', '/api/auth/signin', {
        body: { email: address, password },
    });
    check(`signin dashboard user (${isOwner})`, signin.status === 200, `status=${signin.status}`);
    return signin.json?.data?.token;
}

async function createCustomer(token, name) {
    return (await request('POST', '/api/customers', { token, body: { name } })).json?.data?.customer;
}

async function createProduct(token, body) {
    return (await request('POST', '/api/products', { token, body })).json?.data?.product;
}

async function createInvoice(token, { customerId, invoiceDate, dueDate, items }) {
    const body = { customerId, invoiceDate, items };
    if (dueDate) body.dueDate = dueDate;
    return (await request('POST', '/api/invoices', { token, body })).json?.data?.invoice;
}

async function issue(token, id) {
    return request('PATCH', `/api/invoices/${id}/issue`, { token });
}

async function pay(token, id) {
    return request('PATCH', `/api/invoices/${id}/pay`, { token });
}

async function issueAndPay(token, id) {
    await issue(token, id);
    return pay(token, id);
}

async function run() {
    let token;
    let otherToken;
    let emptyToken;
    let currentOnlyToken;

    try {
        token = await createTestUser(ownerEmail, 'owner');
        otherToken = await createTestUser(otherEmail, 'other');
        emptyToken = await createTestUser(emptyEmail, 'empty');
        currentOnlyToken = await createTestUser(currentOnlyEmail, 'current');
        if (!token || !otherToken || !emptyToken || !currentOnlyToken) {
            throw new Error('Could not obtain all access tokens');
        }

        // ------------------------------------------------------------- fixtures
        const customerOne = await createCustomer(token, `Dashboard Customer One ${stamp}`);
        const customerTwo = await createCustomer(token, `Dashboard Customer Two ${stamp}`);
        const productOne = await createProduct(token, {
            name: `Dashboard Product One ${stamp}`,
            code: `DP1-${stamp}`,
            price: 100,
            taxRate: 10,
            stockQuantity: 1000,
        });
        const productTwo = await createProduct(token, {
            name: `Dashboard Product Two ${stamp}`,
            code: `DP2-${stamp}`,
            price: 50,
            taxRate: 5,
            stockQuantity: 1000,
        });

        // Current month: paid 110.00, issued 210.00, draft and cancelled excluded.
        const paidCurrent = await createInvoice(token, {
            customerId: customerOne.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: productOne.id, quantity: 1 }],
        });
        await issueAndPay(token, paidCurrent.id);

        const issuedCurrent = await createInvoice(token, {
            customerId: customerTwo.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: productTwo.id, quantity: 4 }],
        });
        await issue(token, issuedCurrent.id);

        const draftCurrent = await createInvoice(token, {
            customerId: customerOne.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: productOne.id, quantity: 100 }],
        });

        const cancelledCurrent = await createInvoice(token, {
            customerId: customerTwo.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: productTwo.id, quantity: 1 }],
        });
        await request('PATCH', `/api/invoices/${cancelledCurrent.id}/cancel`, { token });

        // Previous month: paid 110.00, issued 105.00.
        const paidPrevious = await createInvoice(token, {
            customerId: customerOne.id,
            invoiceDate: previousMonthEndStr,
            items: [{ productId: productOne.id, quantity: 1 }],
        });
        await issueAndPay(token, paidPrevious.id);

        const issuedPrevious = await createInvoice(token, {
            customerId: customerTwo.id,
            invoiceDate: previousMonthEndStr,
            items: [{ productId: productTwo.id, quantity: 2 }],
        });
        await issue(token, issuedPrevious.id);

        // Overdue issued: 3 x 52.50 = 157.50.
        const overdueInvoice = await createInvoice(token, {
            customerId: customerTwo.id,
            invoiceDate: overdueInvoiceDateStr,
            dueDate: overdueDueDateStr,
            items: [{ productId: productTwo.id, quantity: 3 }],
        });
        await issue(token, overdueInvoice.id);

        // Other tenant: must never appear in the owner's dashboard.
        const otherCustomer = await createCustomer(otherToken, `Other Dashboard Customer ${stamp}`);
        const otherProduct = await createProduct(otherToken, {
            name: `Other Dashboard Product ${stamp}`,
            code: `ODP-${stamp}`,
            price: 100,
            taxRate: 10,
            stockQuantity: 100,
        });
        const otherPaid = await createInvoice(otherToken, {
            customerId: otherCustomer.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: otherProduct.id, quantity: 1 }],
        });
        await issueAndPay(otherToken, otherPaid.id);

        // Current-month-only tenant: previous month is zero, so change is null.
        const currentOnlyCustomer = await createCustomer(currentOnlyToken, `Current Only Customer ${stamp}`);
        const currentOnlyProduct = await createProduct(currentOnlyToken, {
            name: `Current Only Product ${stamp}`,
            code: `COP-${stamp}`,
            price: 100,
            taxRate: 10,
            stockQuantity: 100,
        });
        const currentOnlyPaid = await createInvoice(currentOnlyToken, {
            customerId: currentOnlyCustomer.id,
            invoiceDate: currentMonthStartStr,
            items: [{ productId: currentOnlyProduct.id, quantity: 1 }],
        });
        await issueAndPay(currentOnlyToken, currentOnlyPaid.id);

        check('dashboard fixtures created',
            customerOne?.id && customerTwo?.id && productOne?.id && productTwo?.id &&
                paidCurrent?.id && issuedCurrent?.id && draftCurrent?.id && cancelledCurrent?.id &&
                paidPrevious?.id && issuedPrevious?.id && overdueInvoice?.id && otherPaid?.id);

        // ------------------------------------------------------------- summary
        const response = await request('GET', '/api/dashboard/summary', { token });
        const data = response.json?.data;

        check('dashboard returns 200', response.status === 200, `status=${response.status}`);
        check('dashboard echoes the UTC current month and year',
            data?.period?.currentMonth?.startDate === currentMonthStartStr &&
                data?.period?.currentMonth?.endDate === currentMonthEndStr &&
                data?.period?.currentYear?.startDate === `${currentYear}-01-01` &&
                data?.period?.currentYear?.endDate === `${currentYear}-12-31`,
            JSON.stringify(data?.period));

        check('current-month sales exclude draft and cancelled',
            data?.sales?.currentMonth === 320,
            `currentMonth=${data?.sales?.currentMonth}`);
        check('previous-month sales are calculated separately',
            data?.sales?.previousMonth === 215,
            `previousMonth=${data?.sales?.previousMonth}`);
        check('percentage change is rounded half-up',
            data?.sales?.changePercentage === 48.84,
            `change=${data?.sales?.changePercentage}`);
        check('current-year sales include only invoices in the current year',
            data?.sales?.currentYear === 320 + (previousInCurrentYear ? 215 : 0) + (overdueInCurrentYear ? 157.5 : 0),
            `currentYear=${data?.sales?.currentYear}`);
        check('all-time sales helper matches completed invoices',
            data?.sales?.allTime === 692.5,
            `allTime=${data?.sales?.allTime}`);

        check('invoice total and status counts cover all statuses',
            data?.invoices?.currentMonth?.total === 4 &&
                data?.invoices?.currentMonth?.byStatus?.draft === 1 &&
                data?.invoices?.currentMonth?.byStatus?.issued === 1 &&
                data?.invoices?.currentMonth?.byStatus?.paid === 1 &&
                data?.invoices?.currentMonth?.byStatus?.cancelled === 1,
            JSON.stringify(data?.invoices?.currentMonth));
        check('paid and outstanding invoice counts follow the status model',
            data?.invoices?.currentMonth?.paid === 1 &&
                data?.invoices?.currentMonth?.outstanding === 1);

        check('tax recorded distinguishes completed invoices',
            data?.tax?.recorded?.currentMonth === 20 && data?.tax?.recorded?.allTime === 42.5,
            JSON.stringify(data?.tax?.recorded));
        check('tax collected only counts paid invoices',
            data?.tax?.collected?.currentMonth === 10 && data?.tax?.collected?.allTime === 20,
            JSON.stringify(data?.tax?.collected));
        check('tax outstanding is issued tax',
            data?.tax?.outstanding?.currentMonth === 10 && data?.tax?.outstanding?.allTime === 22.5,
            JSON.stringify(data?.tax?.outstanding));
        check('current-year tax is calculated consistently',
            data?.tax?.recorded?.currentYear === 20 + (previousInCurrentYear ? 15 : 0) + (overdueInCurrentYear ? 7.5 : 0) &&
                data?.tax?.collected?.currentYear === 10 + (previousInCurrentYear ? 10 : 0),
            JSON.stringify({ recorded: data?.tax?.recorded?.currentYear, collected: data?.tax?.collected?.currentYear }));

        check('outstanding balances include every issued invoice',
            data?.outstanding?.amount === 472.5 &&
                data?.outstanding?.invoiceCount === 3 &&
                data?.outstanding?.overdueAmount === 157.5 &&
                data?.outstanding?.overdueInvoiceCount === 1,
            JSON.stringify(data?.outstanding));

        // ------------------------------------------------------ recent invoices
        const recent = data?.recentInvoices || [];
        check('recent invoices returns the latest five',
            recent.length === 5,
            `length=${recent.length}`);
        check('recent invoices are ordered by invoice date then id (newest first)',
            recent[0]?.id === cancelledCurrent.id &&
                recent[1]?.id === draftCurrent.id &&
                recent[2]?.id === issuedCurrent.id &&
                recent[3]?.id === paidCurrent.id &&
                recent[4]?.id === issuedPrevious.id,
            JSON.stringify(recent.map((invoice) => invoice.id)));
        check('recent invoices include customer names and actual statuses',
            recent[0]?.customerName === customerTwo.name &&
                recent[3]?.customerName === customerOne.name &&
                recent[3]?.status === 'paid' &&
                recent[4]?.status === 'issued',
            JSON.stringify(recent.map((invoice) => ({ id: invoice.id, name: invoice.customerName, status: invoice.status }))));
        check('recent invoices expose the stored grand total',
            recent[3]?.grandTotal === 110 && recent[2]?.grandTotal === 210);

        // -------------------------------------------------------- top products
        const top = data?.topProducts || [];
        check('top products are ranked by snapshotted quantity',
            top.length === 2 &&
                top[0]?.productId === productTwo.id &&
                top[0]?.quantitySold === 9 &&
                top[1]?.productId === productOne.id &&
                top[1]?.quantitySold === 2,
            JSON.stringify(top));
        check('top products exclude draft and cancelled quantities',
            top.every((product) => product.productId !== null) &&
                top.find((product) => product.productId === productOne.id)?.quantitySold === 2,
            JSON.stringify(top));
        check('top products do not leak another tenant',
            top.every((product) => product.productId !== otherProduct.id));

        // Product edits after the sales must not rewrite the dashboard's snapshots.
        await request('PUT', `/api/products/${productTwo.id}`, {
            token,
            body: { name: 'Dashboard Product Two Renamed', price: 999, taxRate: 30 },
        });
        const afterProductEdit = await request('GET', '/api/dashboard/summary', { token });
        const topAfterEdit = afterProductEdit.json?.data?.topProducts?.[0];
        check('top products keep the invoice-item name/amount snapshots',
            topAfterEdit?.productId === productTwo.id &&
                topAfterEdit?.name === productTwo.name &&
                topAfterEdit?.quantitySold === 9 &&
                topAfterEdit?.salesSubtotal === 450,
            JSON.stringify(topAfterEdit));

        // ------------------------------------------------------------ isolation
        const otherResponse = await request('GET', '/api/dashboard/summary', { token: otherToken });
        const otherData = otherResponse.json?.data;
        check('other tenant only sees their own dashboard',
            otherResponse.status === 200 &&
                otherData?.sales?.currentMonth === 110 &&
                otherData?.invoices?.currentMonth?.total === 1 &&
                otherData?.recentInvoices?.length === 1 &&
                otherData?.recentInvoices?.[0]?.customerName === otherCustomer.name,
            JSON.stringify(otherData?.sales));

        // ------------------------------------------------------------ empty user
        const emptyResponse = await request('GET', '/api/dashboard/summary', { token: emptyToken });
        const emptyData = emptyResponse.json?.data;
        check('empty dashboard returns zeros and empty arrays',
            emptyResponse.status === 200 &&
                emptyData?.sales?.currentMonth === 0 &&
                emptyData?.sales?.previousMonth === 0 &&
                emptyData?.sales?.changePercentage === null &&
                emptyData?.sales?.currentYear === 0 &&
                emptyData?.invoices?.currentMonth?.total === 0 &&
                emptyData?.invoices?.currentMonth?.byStatus?.draft === 0 &&
                emptyData?.invoices?.currentMonth?.byStatus?.issued === 0 &&
                emptyData?.invoices?.currentMonth?.byStatus?.paid === 0 &&
                emptyData?.invoices?.currentMonth?.byStatus?.cancelled === 0 &&
                emptyData?.tax?.recorded?.currentMonth === 0 &&
                emptyData?.outstanding?.amount === 0 &&
                emptyData?.recentInvoices?.length === 0 &&
                emptyData?.topProducts?.length === 0,
            JSON.stringify(emptyData));

        const currentOnlyResponse = await request('GET', '/api/dashboard/summary', { token: currentOnlyToken });
        const currentOnlyData = currentOnlyResponse.json?.data;
        check('percentage change is null when the previous month is zero',
            currentOnlyResponse.status === 200 &&
                currentOnlyData?.sales?.currentMonth === 110 &&
                currentOnlyData?.sales?.previousMonth === 0 &&
                currentOnlyData?.sales?.changePercentage === null,
            JSON.stringify(currentOnlyData?.sales));

        // ------------------------------------------------ report consistency
        const reportCurrent = await request(
            'GET',
            `/api/reports/summary?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const reportCurrentData = reportCurrent.json?.data;
        check('dashboard current-month sales match the reports module',
            reportCurrentData?.totalSales === data?.sales?.currentMonth,
            `reports=${reportCurrentData?.totalSales}, dashboard=${data?.sales?.currentMonth}`);
        check('dashboard current-month tax matches the reports module',
            reportCurrentData?.taxCollected === data?.tax?.collected?.currentMonth &&
                reportCurrentData?.taxOutstanding === data?.tax?.outstanding?.currentMonth);
        check('dashboard current-month invoice counts match the reports module',
            reportCurrentData?.paidInvoiceCount === data?.invoices?.currentMonth?.paid &&
                reportCurrentData?.unpaidInvoiceCount === data?.invoices?.currentMonth?.outstanding);

        const reportAll = await request('GET', '/api/reports/summary', { token });
        const reportAllData = reportAll.json?.data;
        check('dashboard outstanding balances match the reports module',
            reportAllData?.outstandingAmount === data?.outstanding?.amount &&
                reportAllData?.overdueAmount === data?.outstanding?.overdueAmount &&
                reportAllData?.overdueInvoiceCount === data?.outstanding?.overdueInvoiceCount,
            JSON.stringify({ reports: reportAllData?.outstandingAmount, dashboard: data?.outstanding?.amount }));

        const reportTax = await request('GET', '/api/reports/tax', { token });
        check('dashboard all-time tax matches the reports tax report',
            reportTax.status === 200 &&
                reportTax.json?.data?.taxRecorded === data?.tax?.recorded?.allTime &&
                reportTax.json?.data?.taxCollected === data?.tax?.collected?.allTime &&
                reportTax.json?.data?.taxOutstanding === data?.tax?.outstanding?.allTime);

        // ------------------------------------------------------------ validation
        const noAuth = await request('GET', '/api/dashboard/summary');
        check('dashboard requires authentication', noAuth.status === 401, `status=${noAuth.status}`);

        const unknown = await request('GET', '/api/dashboard/summary?month=2026-01', { token });
        check('dashboard rejects unsupported query parameters', unknown.status === 400, `status=${unknown.status}`);
    } finally {
        for (const id of [ownerId, otherId, emptyId, currentOnlyId]) {
            if (!Number.isSafeInteger(id)) continue;
            await prisma.invoice.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.product.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nDashboard API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nDashboard API test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
