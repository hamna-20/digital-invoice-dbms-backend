/**
 * End-to-end tests for /api/reports.
 *
 * Requires a running API and SQL Server database:
 *   node test/report.e2e.mjs
 *
 * Business rules exercised:
 *   - sales/tax only include issued + paid invoices (draft/cancelled excluded)
 *   - period is based on invoiceDate, never paidAt
 *   - tax snapshots come from InvoiceItem, not current product rates
 *   - overdue is derived from issued + past dueDate
 *   - every query is scoped to the authenticated userId
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const ownerEmail = `test.report.${stamp}@example.test`;
const otherEmail = `test.report.other.${stamp}@example.test`;
const results = [];

let ownerId;
let otherId;

const ymd = (date) => date.toISOString().slice(0, 10);
const dayOffset = (offset) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return date;
};

const today = new Date();
const todayStr = ymd(today);
const currentYear = today.getUTCFullYear();
const currentMonthStart = new Date(Date.UTC(currentYear, today.getUTCMonth(), 1));
const currentMonthEnd = new Date(Date.UTC(currentYear, today.getUTCMonth() + 1, 0));
const previousMonthEnd = new Date(Date.UTC(currentYear, today.getUTCMonth(), 0));
const overdueInvoiceDate = dayOffset(-40);
const overdueDueDate = dayOffset(-5);
const rangeStart40 = ymd(overdueInvoiceDate);

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
            fullName: 'Report API Test',
            email: address,
            password,
            confirmPassword: password,
        },
    });
    check(`signup report user (${isOwner ? 'owner' : 'other'})`, signup.status === 201, `status=${signup.status}`);
    const id = signup.json?.data?.user?.id;
    if (Number.isSafeInteger(id)) {
        if (isOwner) ownerId = id;
        else otherId = id;
    }

    const signin = await request('POST', '/api/auth/signin', {
        body: { email: address, password },
    });
    check(`signin report user (${isOwner ? 'owner' : 'other'})`, signin.status === 200, `status=${signin.status}`);
    return signin.json?.data?.token;
}

async function createCustomer(token, name) {
    const response = await request('POST', '/api/customers', { token, body: { name } });
    return response.json?.data?.customer;
}

async function createProduct(token, body) {
    const response = await request('POST', '/api/products', { token, body });
    return response.json?.data?.product;
}

async function createInvoice(token, { customerId, invoiceDate, dueDate, items }) {
    const body = { customerId, invoiceDate, items };
    if (dueDate) body.dueDate = dueDate;
    const response = await request('POST', '/api/invoices', { token, body });
    return { response, invoice: response.json?.data?.invoice };
}

async function issue(token, invoiceId) {
    return request('PATCH', `/api/invoices/${invoiceId}/issue`, { token });
}

async function pay(token, invoiceId) {
    return request('PATCH', `/api/invoices/${invoiceId}/pay`, { token });
}

async function run() {
    let token;
    let otherToken;

    try {
        token = await createTestUser(ownerEmail, true);
        if (!token) throw new Error('Could not obtain an access token for the owner test user');
        otherToken = await createTestUser(otherEmail, false);
        if (!otherToken) throw new Error('Could not obtain an access token for the other test user');

        // ------------------------------------------------------------- fixtures
        const customerOne = await createCustomer(token, `Report Customer One ${stamp}`);
        const customerTwo = await createCustomer(token, `Report Customer Two ${stamp}`);
        const otherCustomer = await createCustomer(otherToken, `Other Report Customer ${stamp}`);

        const productOne = await createProduct(token, {
            name: `Report Product One ${stamp}`,
            code: `RP1-${stamp}`,
            price: 100,
            taxRate: 10,
            stockQuantity: 1000,
        });
        const productTwo = await createProduct(token, {
            name: `Report Product Two ${stamp}`,
            code: `RP2-${stamp}`,
            price: 50,
            taxRate: 5,
            stockQuantity: 1000,
        });
        const productThree = await createProduct(token, {
            name: `Report Product Three ${stamp}`,
            code: `RP3-${stamp}`,
            price: 50,
            taxRate: 0,
            stockQuantity: 1000,
        });
        const otherProduct = await createProduct(otherToken, {
            name: `Other Report Product ${stamp}`,
            code: `ORP-${stamp}`,
            price: 100,
            taxRate: 10,
            stockQuantity: 100,
        });

        check(
            'fixtures created',
            customerOne?.id && customerTwo?.id && productOne?.id && productTwo?.id && productThree?.id && otherProduct?.id
        );

        // Current-month paid: 1 x 110.00 = 110.00
        const paidCurrent = (
            await createInvoice(token, {
                customerId: customerOne.id,
                invoiceDate: currentMonthStartStr,
                items: [{ productId: productOne.id, quantity: 1 }],
            })
        ).invoice;
        await issue(token, paidCurrent.id);
        const paidCurrentFinal = await pay(token, paidCurrent.id);

        // Current-month issued: 4 x 52.50 = 210.00
        const issuedCurrent = (
            await createInvoice(token, {
                customerId: customerTwo.id,
                invoiceDate: currentMonthStartStr,
                items: [{ productId: productTwo.id, quantity: 4 }],
            })
        ).invoice;
        const issuedCurrentFinal = await issue(token, issuedCurrent.id);

        // Current-month draft: must never reach sales/tax/top products.
        const draftCurrent = (
            await createInvoice(token, {
                customerId: customerOne.id,
                invoiceDate: currentMonthStartStr,
                items: [{ productId: productOne.id, quantity: 10 }],
            })
        ).invoice;

        // Current-month cancelled: same exclusion.
        const cancelledCurrent = (
            await createInvoice(token, {
                customerId: customerTwo.id,
                invoiceDate: currentMonthStartStr,
                items: [{ productId: productTwo.id, quantity: 1 }],
            })
        ).invoice;
        const cancelledCurrentFinal = await request('PATCH', `/api/invoices/${cancelledCurrent.id}/cancel`, { token });

        // Previous-month paid: 110.00
        const paidPrevious = (
            await createInvoice(token, {
                customerId: customerOne.id,
                invoiceDate: previousMonthEndStr,
                items: [{ productId: productOne.id, quantity: 1 }],
            })
        ).invoice;
        await issue(token, paidPrevious.id);
        const paidPreviousFinal = await pay(token, paidPrevious.id);

        // Previous-month issued: 2 x 52.50 = 105.00
        const issuedPrevious = (
            await createInvoice(token, {
                customerId: customerTwo.id,
                invoiceDate: previousMonthEndStr,
                items: [{ productId: productTwo.id, quantity: 2 }],
            })
        ).invoice;
        const issuedPreviousFinal = await issue(token, issuedPrevious.id);

        // 40 days ago, overdue: 3 x 50.00 = 150.00
        const overdueInvoice = (
            await createInvoice(token, {
                customerId: customerTwo.id,
                invoiceDate: overdueInvoiceDateStr,
                dueDate: overdueDueDateStr,
                items: [{ productId: productThree.id, quantity: 3 }],
            })
        ).invoice;
        const overdueFinal = await issue(token, overdueInvoice.id);

        // Other user's paid invoice must never leak.
        const otherPaid = (
            await createInvoice(otherToken, {
                customerId: otherCustomer.id,
                invoiceDate: currentMonthStartStr,
                items: [{ productId: otherProduct.id, quantity: 1 }],
            })
        ).invoice;
        await issue(otherToken, otherPaid.id);
        await pay(otherToken, otherPaid.id);

        check(
            'fixtures have expected statuses',
            paidCurrentFinal.json?.data?.invoice?.status === 'paid' &&
                issuedCurrentFinal.json?.data?.invoice?.status === 'issued' &&
                draftCurrent?.status === 'draft' &&
                cancelledCurrentFinal.json?.data?.invoice?.status === 'cancelled' &&
                paidPreviousFinal.json?.data?.invoice?.status === 'paid' &&
                issuedPreviousFinal.json?.data?.invoice?.status === 'issued' &&
                overdueFinal.json?.data?.invoice?.status === 'overdue'
        );

        // ------------------------------------------------------------- summary
        const currentSummary = await request(
            'GET',
            `/api/reports/summary?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const current = currentSummary.json?.data;
        check('current-month summary returns 200', currentSummary.status === 200, `status=${currentSummary.status}`);
        check('summary excludes drafts and cancelled from sales', current?.totalSales === 320, `totalSales=${current?.totalSales}`);
        check('summary subtotal and tax are correct', current?.salesSubtotal === 300 && current?.taxTotal === 20,
            `subtotal=${current?.salesSubtotal}, tax=${current?.taxTotal}`);
        check('summary counts all statuses but completed separately',
            current?.invoiceCount === 4 && current?.completedInvoiceCount === 2,
            `invoices=${current?.invoiceCount}, completed=${current?.completedInvoiceCount}`);
        check('summary paid/unpaid counts follow the status model', current?.paidInvoiceCount === 1 && current?.unpaidInvoiceCount === 1);
        check('summary collects tax only from paid invoices', current?.taxCollected === 10 && current?.taxOutstanding === 10,
            `collected=${current?.taxCollected}, outstanding=${current?.taxOutstanding}`);
        check('summary average invoice value uses completed invoices', current?.averageInvoiceValue === 160,
            `avg=${current?.averageInvoiceValue}`);
        check('summary has no overdue invoices in the current month', current?.overdueInvoiceCount === 0, `overdue=${current?.overdueInvoiceCount}`);
        check('summary echoes the requested period', current?.period?.startDate === currentMonthStartStr && current?.period?.endDate === currentMonthEndStr);

        const allSummary = await request('GET', '/api/reports/summary', { token });
        const all = allSummary.json?.data;
        check('all-time summary has 200', allSummary.status === 200);
        check('all-time summary totals completed sales', all?.totalSales === 685, `totalSales=${all?.totalSales}`);
        check('all-time summary totals outstanding and overdue',
            all?.outstandingAmount === 465 && all?.overdueAmount === 150 && all?.overdueInvoiceCount === 1,
            `outstanding=${all?.outstandingAmount}, overdue=${all?.overdueAmount}, overdueCount=${all?.overdueInvoiceCount}`);
        check('all-time summary tax recorded/collected/outstanding',
            all?.taxTotal === 35 && all?.taxCollected === 20 && all?.taxOutstanding === 15,
            `recorded=${all?.taxTotal}, collected=${all?.taxCollected}, outstanding=${all?.taxOutstanding}`);
        check('all-time summary counts 7 invoices', all?.invoiceCount === 7, `invoices=${all?.invoiceCount}`);

        // ------------------------------------------------------- daily report
        const daily = await request(
            'GET',
            `/api/reports/daily-sales?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const day = daily.json?.data?.days?.[0];
        check('daily report returns one grouped day', daily.status === 200 && daily.json?.data?.days?.length === 1);
        check('daily report excludes draft/cancelled and groups statuses',
            day?.date === currentMonthStartStr &&
                day?.invoiceCount === 2 &&
                day?.paidInvoiceCount === 1 &&
                day?.unpaidInvoiceCount === 1,
            JSON.stringify(day));
        check('daily report money matches the summary',
            day?.totalSales === 320 && day?.paidAmount === 110 && day?.outstandingAmount === 210 && day?.taxTotal === 20);

        // ----------------------------------------------------- monthly report
        const monthlyYear = await request('GET', `/api/reports/monthly-sales?year=${currentYear}`, { token });
        const monthlyYearData = monthlyYear.json?.data;
        const currentMonthKey = currentMonthStartStr.slice(0, 7);
        const currentMonthRow = monthlyYearData?.months?.find((row) => row.monthKey === currentMonthKey);
        const expectedYearSales =
            320 + (previousInCurrentYear ? 215 : 0) + (overdueInCurrentYear ? 150 : 0);
        check('monthly report returns months inside the requested year',
            monthlyYear.status === 200 &&
                monthlyYearData?.months?.every((row) => row.year === currentYear) &&
                Boolean(currentMonthRow),
            `months=${monthlyYearData?.months?.map((row) => row.monthKey).join(',')}`);
        check('monthly report current month and year totals are correct',
            currentMonthRow?.totalSales === 320 && monthlyYearData?.totals?.totalSales === expectedYearSales,
            `month=${currentMonthRow?.totalSales}, year=${monthlyYearData?.totals?.totalSales}, expected=${expectedYearSales}`);

        const monthlyIntersection = await request(
            'GET',
            `/api/reports/monthly-sales?year=${currentYear}&startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        check('monthly report intersects year and explicit range',
            monthlyIntersection.status === 200 &&
                monthlyIntersection.json?.data?.months?.length === 1 &&
                monthlyIntersection.json?.data?.totals?.totalSales === 320);

        // --------------------------------------------------------- tax report
        const currentTax = await request(
            'GET',
            `/api/reports/tax?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const currentTaxData = currentTax.json?.data;
        check('current-month tax report returns two rates', currentTax.status === 200 && currentTaxData?.rates?.length === 2,
            `rates=${currentTaxData?.rates?.length}`);
        check('current-month tax report uses item snapshots',
            currentTaxData?.taxRecorded === 20 && currentTaxData?.taxCollected === 10 && currentTaxData?.taxOutstanding === 10,
            JSON.stringify(currentTaxData));
        const tenPercent = currentTaxData?.rates?.find((row) => row.taxRate === 10);
        const fivePercent = currentTaxData?.rates?.find((row) => row.taxRate === 5);
        check('tax rates are grouped with taxable sales',
            tenPercent?.taxableSales === 100 && tenPercent?.taxRecorded === 10 && tenPercent?.taxCollected === 10 &&
                fivePercent?.taxableSales === 200 && fivePercent?.taxRecorded === 10 && fivePercent?.taxCollected === 0);

        const allTax = await request('GET', '/api/reports/tax', { token });
        check('all-time tax report totals are correct',
            allTax.status === 200 &&
                allTax.json?.data?.taxRecorded === 35 &&
                allTax.json?.data?.taxCollected === 20 &&
                allTax.json?.data?.taxOutstanding === 15 &&
                allTax.json?.data?.taxableSales === 650,
            JSON.stringify(allTax.json?.data));

        // ---------------------------------------------------- customer report
        const customersCurrent = await request(
            'GET',
            `/api/reports/customers?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const currentCustomers = customersCurrent.json?.data?.customers || [];
        check('customer report is scoped and sorted by amount',
            customersCurrent.status === 200 &&
                currentCustomers.length === 2 &&
                currentCustomers[0].customerId === customerTwo.id &&
                currentCustomers[0].totalInvoiced === 210 &&
                currentCustomers[1].customerId === customerOne.id &&
                currentCustomers[1].totalInvoiced === 110,
            JSON.stringify(currentCustomers));

        const customersAll = await request('GET', '/api/reports/customers', { token });
        const allCustomers = customersAll.json?.data;
        check('all-time customer report aggregates paid/outstanding/overdue',
            allCustomers?.customers?.length === 2 &&
                allCustomers.customers[0].customerId === customerTwo.id &&
                allCustomers.customers[0].invoiceCount === 3 &&
                allCustomers.customers[0].totalInvoiced === 465 &&
                allCustomers.customers[0].paidAmount === 0 &&
                allCustomers.customers[0].outstandingAmount === 465 &&
                allCustomers.customers[0].overdueAmount === 150 &&
                allCustomers.customers[1].totalInvoiced === 220 &&
                allCustomers.customers[1].paidAmount === 220,
            JSON.stringify(allCustomers));

        const customerPage = await request('GET', '/api/reports/customers?limit=1&page=1', { token });
        const customerPageTwo = await request('GET', '/api/reports/customers?limit=1&page=2', { token });
        check('customer report paginates a stable sorted list',
            customerPage.json?.data?.pagination?.total === 2 &&
                customerPage.json?.data?.pagination?.totalPages === 2 &&
                customerPage.json?.data?.customers?.[0]?.customerId === customerTwo.id &&
                customerPageTwo.json?.data?.customers?.[0]?.customerId === customerOne.id);

        // ----------------------------------------------------- product report
        const productsCurrent = await request(
            'GET',
            `/api/reports/products?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}`,
            { token }
        );
        const currentProducts = productsCurrent.json?.data?.products || [];
        check('current-month product report excludes draft/cancelled quantities',
            productsCurrent.status === 200 &&
                currentProducts.length === 2 &&
                currentProducts[0].productId === productTwo.id &&
                currentProducts[0].quantitySold === 4 &&
                currentProducts[1].productId === productOne.id &&
                currentProducts[1].quantitySold === 1,
            JSON.stringify(currentProducts));

        const productsAll = await request('GET', '/api/reports/products', { token });
        const allProducts = productsAll.json?.data?.products || [];
        check('all-time product report ranks by snapshotted revenue',
            productsAll.status === 200 &&
                allProducts.length === 3 &&
                allProducts[0].productId === productTwo.id &&
                allProducts[0].quantitySold === 6 &&
                allProducts[0].salesSubtotal === 300 &&
                allProducts[1].productId === productOne.id &&
                allProducts[1].quantitySold === 2 &&
                allProducts[1].salesSubtotal === 200 &&
                allProducts[2].productId === productThree.id &&
                allProducts[2].quantitySold === 3 &&
                allProducts[2].salesSubtotal === 150,
            JSON.stringify(allProducts));
        check('product report tax amounts come from line snapshots',
            allProducts[0].taxAmount === 15 && allProducts[1].taxAmount === 20 && allProducts[2].taxAmount === 0);

        // Changing a product's tax rate must not rewrite history.
        await request('PUT', `/api/products/${productOne.id}`, { token, body: { taxRate: 25 } });
        const taxAfterRateChange = await request('GET', '/api/reports/tax', { token });
        check('changing a product tax rate does not change report tax',
            taxAfterRateChange.status === 200 &&
                taxAfterRateChange.json?.data?.taxRecorded === 35 &&
                taxAfterRateChange.json?.data?.rates?.some((row) => row.taxRate === 10));

        // ---------------------------------------------------- invoice history
        const history = await request('GET', '/api/reports/invoice-history?limit=2&page=1', { token });
        check('invoice history paginates',
            history.status === 200 &&
                history.json?.data?.pagination?.total === 7 &&
                history.json?.data?.pagination?.totalPages === 4 &&
                history.json?.data?.invoices?.length === 2,
            JSON.stringify(history.json?.data?.pagination));

        const historyCurrent = await request(
            'GET',
            `/api/reports/invoice-history?startDate=${currentMonthStartStr}&endDate=${currentMonthEndStr}&limit=100`,
            { token }
        );
        check('invoice history applies the date range and includes drafts/cancelled',
            historyCurrent.status === 200 &&
                historyCurrent.json?.data?.pagination?.total === 4 &&
                historyCurrent.json?.data?.invoices?.some((invoice) => invoice.status === 'draft') &&
                historyCurrent.json?.data?.invoices?.some((invoice) => invoice.status === 'cancelled'));

        const paidHistory = await request('GET', '/api/reports/invoice-history?status=paid&limit=100', { token });
        check('invoice history status=paid', paidHistory.status === 200 && paidHistory.json?.data?.pagination?.total === 2);

        const issuedHistory = await request('GET', '/api/reports/invoice-history?status=issued&limit=100', { token });
        check('invoice history status=issued excludes overdue',
            issuedHistory.status === 200 &&
                issuedHistory.json?.data?.pagination?.total === 2 &&
                issuedHistory.json?.data?.invoices?.every((invoice) => invoice.status === 'issued'));

        const overdueHistory = await request('GET', '/api/reports/invoice-history?status=overdue&limit=100', { token });
        check('invoice history status=overdue returns the derived status',
            overdueHistory.status === 200 &&
                overdueHistory.json?.data?.pagination?.total === 1 &&
                overdueHistory.json?.data?.invoices?.[0]?.id === overdueInvoice.id &&
                overdueHistory.json?.data?.invoices?.[0]?.status === 'overdue');

        const searchNumber = await request(
            'GET',
            `/api/reports/invoice-history?search=${encodeURIComponent(paidCurrent.invoiceNumber)}`,
            { token }
        );
        check('invoice history searches by invoice number',
            searchNumber.status === 200 &&
                searchNumber.json?.data?.pagination?.total === 1 &&
                searchNumber.json?.data?.invoices?.[0]?.id === paidCurrent.id);

        const searchCustomer = await request(
            'GET',
            `/api/reports/invoice-history?search=${encodeURIComponent(customerTwo.name)}&limit=100`,
            { token }
        );
        check('invoice history searches by customer name',
            searchCustomer.status === 200 && searchCustomer.json?.data?.pagination?.total === 4,
            JSON.stringify(searchCustomer.json?.data?.pagination));

        check('invoice history exposes customer names',
            historyCurrent.json?.data?.invoices?.every((invoice) => typeof invoice.customerName === 'string' && invoice.customerName.length > 0));

        // --------------------------------------------------------- isolation
        const otherSummary = await request('GET', '/api/reports/summary', { token: otherToken });
        check('other user only sees their own report data',
            otherSummary.status === 200 &&
                otherSummary.json?.data?.invoiceCount === 1 &&
                otherSummary.json?.data?.totalSales === 110);
        const otherSearch = await request(
            'GET',
            `/api/reports/invoice-history?search=${encodeURIComponent(customerTwo.name)}`,
            { token: otherToken }
        );
        check('other user cannot find another tenant customer',
            otherSearch.status === 200 && otherSearch.json?.data?.pagination?.total === 0);
        check('owner report does not include the other tenant invoice',
            allSummary.json?.data?.invoiceCount === 7 &&
                !historyCurrent.json?.data?.invoices?.some((invoice) => invoice.id === otherPaid.id));

        // -------------------------------------------------------- validation
        const noAuth = await request('GET', '/api/reports/summary');
        check('reports require authentication', noAuth.status === 401, `status=${noAuth.status}`);

        const badDate = await request('GET', '/api/reports/summary?startDate=2026-02-30', { token });
        check('invalid date returns 400', badDate.status === 400, `status=${badDate.status}`);

        const reversed = await request(
            'GET',
            `/api/reports/summary?startDate=${currentMonthEndStr}&endDate=${currentMonthStartStr}`,
            { token }
        );
        check('reversed date range returns 400', reversed.status === 400, `status=${reversed.status}`);

        const unknown = await request('GET', '/api/reports/summary?foo=bar', { token });
        check('unknown report query parameter returns 400', unknown.status === 400, `status=${unknown.status}`);

        const limitTooHigh = await request('GET', '/api/reports/customers?limit=101', { token });
        check('report pagination rejects limit above 100', limitTooHigh.status === 400, `status=${limitTooHigh.status}`);

        const badStatus = await request('GET', '/api/reports/invoice-history?status=unknown', { token });
        check('unknown history status returns 400', badStatus.status === 400, `status=${badStatus.status}`);

        const badYear = await request('GET', '/api/reports/monthly-sales?year=abcd', { token });
        check('invalid monthly year returns 400', badYear.status === 400, `status=${badYear.status}`);

        const badTax = await request(
            'GET',
            `/api/reports/tax?startDate=${currentMonthEndStr}&endDate=${currentMonthStartStr}`,
            { token }
        );
        check('reversed tax range returns 400', badTax.status === 400, `status=${badTax.status}`);
    } finally {
        for (const id of [ownerId, otherId]) {
            if (!Number.isSafeInteger(id)) continue;
            await prisma.invoice.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.product.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nReport API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nReport API test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
