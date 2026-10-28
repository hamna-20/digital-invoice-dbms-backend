/**
 * End-to-end invoice API tests. Requires a running API and SQL Server database.
 *
 * Run with: node test/invoice.e2e.mjs
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const ownerEmail = `test.invoice.${stamp}@example.test`;
const otherEmail = `test.invoice.other.${stamp}@example.test`;
const productCode = (offset) => String((stamp + offset) % 1_000_000).padStart(6, '0');
const results = [];
let ownerId;
let otherId;

const ymd = (date) => date.toISOString().slice(0, 10);
const dayOffset = (offset) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return ymd(date);
};
const today = dayOffset(0);

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
            fullName: 'Invoice API Test',
            email: address,
            password,
            confirmPassword: password,
        },
    });
    check(`signup test user (${isOwner ? 'owner' : 'second user'})`, signup.status === 201, `status=${signup.status}`);
    const id = signup.json?.data?.user?.id;
    if (Number.isSafeInteger(id)) {
        if (isOwner) ownerId = id;
        else otherId = id;
    }

    const signin = await request('POST', '/api/auth/signin', {
        body: { email: address, password },
    });
    check(`signin test user (${isOwner ? 'owner' : 'second user'})`, signin.status === 200, `status=${signin.status}`);
    return signin.json?.data?.token;
}

async function createProduct(token, body) {
    const response = await request('POST', '/api/products', { token, body });
    return { response, product: response.json?.data?.product };
}

async function createCustomer(token, body) {
    const response = await request('POST', '/api/customers', { token, body });
    return { response, customer: response.json?.data?.customer };
}

async function run() {
    let token;
    let otherToken;
    let customer;
    let secondCustomer;
    let otherCustomer;
    let productA;
    let productB;
    let productPenny;
    let productSnapshot;
    let productInactive;
    let productLowStock;
    let otherProduct;

    try {
        token = await createTestUser(ownerEmail, true);
        if (!token) throw new Error('Could not obtain an access token for the owner test user');
        otherToken = await createTestUser(otherEmail, false);
        if (!otherToken) throw new Error('Could not obtain an access token for the second test user');

        const customerResponse = await createCustomer(token, {
            name: `Invoice Customer ${stamp}`,
            email: `invoice.customer.${stamp}@example.test`,
            phone: '0300-0000000',
            address: 'Lahore',
        });
        customer = customerResponse.customer;
        check('invoice test customer created', customerResponse.response.status === 201 && Number.isSafeInteger(customer?.id));

        secondCustomer = (
            await createCustomer(token, { name: `Second Invoice Customer ${stamp}` })
        ).customer;
        otherCustomer = (
            await createCustomer(otherToken, { name: `Other Invoice Customer ${stamp}` })
        ).customer;

        const createdA = await createProduct(token, {
            name: 'Widget A',
            code: productCode(1),
            price: 33.33,
            taxRate: 17.5,
            stockQuantity: 1000,
        });
        productA = createdA.product;

        const createdB = await createProduct(token, {
            name: 'Widget B',
            code: productCode(2),
            price: 10,
            taxRate: 10,
            stockQuantity: 1000,
        });
        productB = createdB.product;

        productPenny = (
            await createProduct(token, {
                name: 'Penny Line',
                code: productCode(3),
                price: 0.05,
                taxRate: 10,
                stockQuantity: 1000,
            })
        ).product;

        productSnapshot = (
            await createProduct(token, {
                name: 'Snapshot Widget',
                code: productCode(4),
                price: 500,
                taxRate: 18,
                stockQuantity: 1000,
            })
        ).product;

        productInactive = (
            await createProduct(token, {
                name: 'Inactive Widget',
                code: productCode(5),
                price: 5,
                taxRate: 0,
                stockQuantity: 10,
                isActive: false,
            })
        ).product;

        productLowStock = (
            await createProduct(token, {
                name: 'Low Stock Widget',
                code: productCode(6),
                price: 7,
                taxRate: 0,
                stockQuantity: 2,
            })
        ).product;

        otherProduct = (
            await createProduct(otherToken, {
                name: 'Other User Widget',
                code: productCode(7),
                price: 1,
                taxRate: 0,
            })
        ).product;

        check('all invoice fixtures created', [productA, productB, productPenny, productSnapshot, productInactive, productLowStock, otherProduct].every(Boolean));

        // ---------------------------------------------------------------- auth
        const noAuth = await request('GET', '/api/invoices');
        check('unauthenticated invoice request returns 401', noAuth.status === 401, `status=${noAuth.status}`);

        // ------------------------------------------------------- create rejects
        const validBody = () => ({
            customerId: customer.id,
            invoiceDate: today,
            items: [{ productId: productA.id, quantity: 1 }],
        });

        for (const [label, body] of [
            ['customer', { invoiceDate: today, items: [{ productId: productA.id, quantity: 1 }] }],
            ['invoice date', { customerId: customer.id, items: [{ productId: productA.id, quantity: 1 }] }],
            ['items', { customerId: customer.id, invoiceDate: today }],
            ['empty items', { customerId: customer.id, invoiceDate: today, items: [] }],
        ]) {
            const response = await request('POST', '/api/invoices', { token, body });
            check(`missing/invalid invoice ${label} returns 400`, response.status === 400, `status=${response.status}`);
        }

        for (const [label, body] of [
            ['zero quantity', { items: [{ productId: productA.id, quantity: 0 }] }],
            ['negative quantity', { items: [{ productId: productA.id, quantity: -2 }] }],
            ['fractional quantity', { items: [{ productId: productA.id, quantity: 1.5 }] }],
            ['missing product', { items: [{ productId: 2147483647, quantity: 1 }] }],
            ['other user product', { items: [{ productId: otherProduct.id, quantity: 1 }] }],
            ['inactive product', { items: [{ productId: productInactive.id, quantity: 1 }] }],
            ['missing product id', { items: [{ quantity: 1 }] }],
            ['client price field', { items: [{ productId: productA.id, quantity: 1, unitPrice: 1 }] }],
            ['client totals', { subtotal: 0, taxTotal: 0, grandTotal: 0 }],
            ['client invoice number', { invoiceNumber: 'INV-HACK' }],
            ['impossible date', { invoiceDate: '2026-02-30' }],
            ['due date before invoice date', { invoiceDate: today, dueDate: dayOffset(-1) }],
            ['invalid customer', { customerId: 2147483647 }],
            ['other user customer', { customerId: otherCustomer.id }],
        ]) {
            const response = await request('POST', '/api/invoices', {
                token,
                body: { customerId: customer.id, invoiceDate: today, ...body },
            });
            check(`invoice create rejects ${label}`, response.status === 400, `status=${response.status}`);
        }

        // ------------------------------------------------------ create success
        const main = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                notes: '  First invoice  ',
                items: [
                    { productId: productA.id, quantity: 3 },
                    { productId: productB.id, quantity: 1 },
                ],
            },
        });
        const mainInvoice = main.json?.data?.invoice;
        check('valid draft invoice returns 201', main.status === 201, `status=${main.status}`);
        check('invoice number is server generated', /^INV-\d+$/.test(mainInvoice?.invoiceNumber || ''), mainInvoice?.invoiceNumber);
        check('new invoice starts as draft', mainInvoice?.status === 'draft');
        check('dates are serialized as YYYY-MM-DD', mainInvoice?.invoiceDate === today && mainInvoice?.dueDate === null);
        check('notes are trimmed', mainInvoice?.notes === 'First invoice');
        check(
            'line totals are calculated from database prices',
            mainInvoice?.items?.length === 2 &&
                mainInvoice.items[0].unitPrice === 33.33 &&
                mainInvoice.items[0].taxRate === 17.5 &&
                mainInvoice.items[0].lineSubtotal === 99.99 &&
                mainInvoice.items[0].lineTax === 17.5 &&
                mainInvoice.items[0].lineTotal === 117.49
        );
        check(
            'invoice totals equal the sum of rounded lines',
            mainInvoice?.subtotal === 109.99 &&
                mainInvoice?.taxTotal === 18.5 &&
                mainInvoice?.grandTotal === 128.49
        );
        check(
            'product snapshots are stored',
            mainInvoice?.items?.[0]?.productName === 'Widget A' &&
                mainInvoice?.items?.[0]?.productCode === productA.code
        );
        check(
            'response includes a safe customer summary',
            mainInvoice?.customer?.id === customer.id &&
                mainInvoice.customer.name === customer.name &&
                !Object.hasOwn(mainInvoice.customer, 'userId')
        );
        check('response does not expose ownership internals', !Object.hasOwn(mainInvoice, 'userId'));

        const penny = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productPenny.id, quantity: 1 }],
            },
        });
        const pennyInvoice = penny.json?.data?.invoice;
        check(
            'half-up rounding is applied at line level (0.005 -> 0.01)',
            penny.status === 201 &&
                pennyInvoice?.items?.[0]?.lineSubtotal === 0.05 &&
                pennyInvoice?.items?.[0]?.lineTax === 0.01 &&
                pennyInvoice?.items?.[0]?.lineTotal === 0.06 &&
                pennyInvoice?.grandTotal === 0.06
        );

        const concurrent = await Promise.all(
            Array.from({ length: 10 }, () =>
                request('POST', '/api/invoices', {
                    token,
                    body: {
                        customerId: customer.id,
                        invoiceDate: today,
                        items: [{ productId: productB.id, quantity: 1 }],
                    },
                })
            )
        );
        await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: secondCustomer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });

        const concurrentNumbers = concurrent.map((response) => response.json?.data?.invoice?.invoiceNumber);
        check(
            'concurrent creates all succeed',
            concurrent.every((response) => response.status === 201),
            `statuses=${concurrent.map((response) => response.status).join(',')}`
        );
        check(
            'concurrent creates produce unique invoice numbers',
            new Set(concurrentNumbers).size === concurrent.length && concurrentNumbers.every((number) => /^INV-\d+$/.test(number || '')),
            concurrentNumbers.join(', ')
        );

        // ---------------------------------------------------------------- list
        const list = await request('GET', '/api/invoices?limit=100', { token });
        const listInvoices = list.json?.data?.invoices || [];
        const listPagination = list.json?.data?.pagination;
        check('invoice list returns 200 and pagination metadata', list.status === 200 && listPagination?.page === 1 && listPagination?.limit === 100);
        check('invoice list returns items and customers', listInvoices.length > 0 && Array.isArray(listInvoices[0].items) && listInvoices[0].customer?.name);
        check(
            'invoice list is newest first (date desc, id desc)',
            listInvoices.every((invoice, index) => {
                if (index === 0) return true;
                const previous = listInvoices[index - 1];
                return previous.invoiceDate > invoice.invoiceDate ||
                    (previous.invoiceDate === invoice.invoiceDate && previous.id > invoice.id);
            })
        );

        const paged = await request('GET', '/api/invoices?page=2&limit=2', { token });
        check('invoice pagination honours page and limit', paged.status === 200 &&
            paged.json?.data?.invoices?.length === 2 &&
            paged.json?.data?.pagination?.page === 2 &&
            paged.json?.data?.pagination?.total === listPagination?.total);

        const numberSearch = await request(
            'GET',
            `/api/invoices?search=${encodeURIComponent(mainInvoice.invoiceNumber)}`,
            { token }
        );
        check('invoice search matches the invoice number', numberSearch.status === 200 &&
            numberSearch.json?.data?.invoices?.some((invoice) => invoice.id === mainInvoice.id));

        const nameSearch = await request(
            'GET',
            `/api/invoices?search=${encodeURIComponent(`Second Invoice Customer ${stamp}`)}`,
            { token }
        );
        check('invoice search matches the customer name', nameSearch.status === 200 &&
            nameSearch.json?.data?.pagination?.total === 1 &&
            nameSearch.json?.data?.invoices?.[0]?.customer?.name === `Second Invoice Customer ${stamp}`);

        const draftFilter = await request('GET', '/api/invoices?status=draft&limit=100', { token });
        check('status filter returns only drafts', draftFilter.status === 200 &&
            draftFilter.json?.data?.invoices?.every((invoice) => invoice.status === 'draft'));

        const customerFilter = await request('GET', `/api/invoices?customerId=${customer.id}&limit=100`, { token });
        check('customer filter returns only that customer', customerFilter.status === 200 &&
            customerFilter.json?.data?.invoices?.length > 0 &&
            customerFilter.json.data.invoices.every((invoice) => invoice.customerId === customer.id));

        const dateFilter = await request('GET', `/api/invoices?from=${today}&to=${today}&limit=100`, { token });
        check('date range filter is applied', dateFilter.status === 200 &&
            dateFilter.json?.data?.invoices?.every((invoice) => invoice.invoiceDate === today));

        for (const [label, query] of [
            ['status', 'status=unknown'],
            ['page', 'page=0'],
            ['limit', 'limit=101'],
            ['unknown parameter', 'bogus=1'],
            ['date order', `from=${today}&to=${dayOffset(-1)}`],
            ['invalid date', 'from=2026-02-30'],
        ]) {
            const response = await request('GET', `/api/invoices?${query}`, { token });
            check(`invalid invoice ${label} query returns 400`, response.status === 400, `status=${response.status}`);
        }

        // -------------------------------------------------------------- detail
        const detail = await request('GET', `/api/invoices/${mainInvoice.id}`, { token });
        const detailInvoice = detail.json?.data?.invoice;
        check('invoice detail returns customer and items', detail.status === 200 &&
            detailInvoice?.id === mainInvoice.id &&
            detailInvoice.customer?.name === customer.name &&
            detailInvoice.items?.length === 2);
        check('invoice detail hides password hashes', !JSON.stringify(detailInvoice).includes('passwordHash'));

        const missingDetail = await request('GET', '/api/invoices/2147483647', { token });
        check('missing invoice detail returns 404', missingDetail.status === 404, `status=${missingDetail.status}`);
        const invalidId = await request('GET', '/api/invoices/not-an-id', { token });
        check('invalid invoice ID returns 400', invalidId.status === 400, `status=${invalidId.status}`);
        const foreignDetail = await request('GET', `/api/invoices/${mainInvoice.id}`, { token: otherToken });
        check('another user cannot read the invoice', foreignDetail.status === 404, `status=${foreignDetail.status}`);
        const foreignList = await request('GET', '/api/invoices', { token: otherToken });
        check('invoice lists are isolated per user', foreignList.status === 200 && foreignList.json?.data?.pagination?.total === 0);

        // -------------------------------------------------------------- update
        const updated = await request('PUT', `/api/invoices/${mainInvoice.id}`, {
            token,
            body: {
                notes: 'Revised draft',
                items: [{ productId: productA.id, quantity: 2 }],
            },
        });
        const updatedInvoice = updated.json?.data?.invoice;
        check('draft invoice update returns 200', updated.status === 200, `status=${updated.status}`);
        check(
            'draft update recalculates totals',
            updatedInvoice?.subtotal === 66.66 &&
                updatedInvoice?.taxTotal === 11.67 &&
                updatedInvoice?.grandTotal === 78.33 &&
                updatedInvoice?.items?.length === 1 &&
                updatedInvoice.notes === 'Revised draft'
        );

        const clearedDueDate = await request('PUT', `/api/invoices/${mainInvoice.id}`, {
            token,
            body: { dueDate: dayOffset(14) },
        });
        check('draft update can set a due date', clearedDueDate.status === 200 &&
            clearedDueDate.json?.data?.invoice?.dueDate === dayOffset(14));
        const nullDueDate = await request('PUT', `/api/invoices/${mainInvoice.id}`, {
            token,
            body: { dueDate: null },
        });
        check('draft update can clear the due date', nullDueDate.status === 200 &&
            nullDueDate.json?.data?.invoice?.dueDate === null);

        const emptyUpdate = await request('PUT', `/api/invoices/${mainInvoice.id}`, { token, body: {} });
        check('empty invoice update returns 400', emptyUpdate.status === 400, `status=${emptyUpdate.status}`);
        const massAssignment = await request('PUT', `/api/invoices/${mainInvoice.id}`, {
            token,
            body: { subtotal: 1 },
        });
        check('client-supplied totals cannot be updated', massAssignment.status === 400, `status=${massAssignment.status}`);
        const missingUpdate = await request('PUT', '/api/invoices/2147483647', { token, body: { notes: 'x' } });
        check('update missing invoice returns 404', missingUpdate.status === 404, `status=${missingUpdate.status}`);

        // ------------------------------------------------------------- issue
        const issued = await request('PATCH', `/api/invoices/${mainInvoice.id}/issue`, { token });
        check('draft invoice can be issued', issued.status === 200 &&
            issued.json?.data?.invoice?.status === 'issued', `status=${issued.status}`);
        const issuedAgain = await request('PATCH', `/api/invoices/${mainInvoice.id}/issue`, { token });
        check('issuing an issued invoice returns 409', issuedAgain.status === 409, `status=${issuedAgain.status}`);
        const editIssued = await request('PUT', `/api/invoices/${mainInvoice.id}`, {
            token,
            body: { notes: 'Edited after issue' },
        });
        check('an issued invoice is still editable until it is paid',
            editIssued.status === 200 && editIssued.json?.data?.invoice?.notes === 'Edited after issue',
            `status=${editIssued.status}`);

        const emptyItemsDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });
        const emptyItemsId = emptyItemsDraft.json?.data?.invoice?.id;
        await prisma.invoiceItem.deleteMany({ where: { invoiceId: emptyItemsId } });
        const issueEmpty = await request('PATCH', `/api/invoices/${emptyItemsId}/issue`, { token });
        check('an invoice without items cannot be issued', issueEmpty.status === 409, `status=${issueEmpty.status}`);
        const emptyAfter = await request('GET', `/api/invoices/${emptyItemsId}`, { token });
        check('a rejected issue leaves the invoice as a draft', emptyAfter.json?.data?.invoice?.status === 'draft');
        await request('DELETE', `/api/invoices/${emptyItemsId}`, { token });

        // ------------------------------------------------------------- stock
        const stockProduct = (
            await createProduct(token, {
                name: 'Stock Widget',
                code: productCode(8),
                price: 1,
                taxRate: 0,
                stockQuantity: 10,
            })
        ).product;

        const stockDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: stockProduct.id, quantity: 3 }],
            },
        });
        const stockDraftId = stockDraft.json?.data?.invoice?.id;
        const stockBefore = await request('GET', `/api/products/${stockProduct.id}`, { token });
        check('creating a draft does not change stock', stockDraft.status === 201 &&
            stockBefore.json?.data?.product?.stockQuantity === 10);

        await request('PATCH', `/api/invoices/${stockDraftId}/issue`, { token });
        const stockAfterIssue = await request('GET', `/api/products/${stockProduct.id}`, { token });
        check('issuing decrements stock', stockAfterIssue.json?.data?.product?.stockQuantity === 7);

        await request('PATCH', `/api/invoices/${stockDraftId}/cancel`, { token });
        const stockAfterCancel = await request('GET', `/api/products/${stockProduct.id}`, { token });
        check('cancelling an issued invoice restores stock', stockAfterCancel.json?.data?.product?.stockQuantity === 10);

        await prisma.product.update({ where: { id: productLowStock.id }, data: { stockQuantity: 2 } });
        const lowStockDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productLowStock.id, quantity: 3 }],
            },
        });
        const lowStockId = lowStockDraft.json?.data?.invoice?.id;
        const insufficient = await request('PATCH', `/api/invoices/${lowStockId}/issue`, { token });
        const lowStockAfter = await request('GET', `/api/invoices/${lowStockId}`, { token });
        const lowStockProduct = await request('GET', `/api/products/${productLowStock.id}`, { token });
        check('insufficient stock blocks the issue with 409', insufficient.status === 409, `status=${insufficient.status}`);
        check('a blocked issue leaves the invoice as a draft', lowStockAfter.json?.data?.invoice?.status === 'draft');
        check('a blocked issue does not change stock', lowStockProduct.json?.data?.product?.stockQuantity === 2);
        await request('DELETE', `/api/invoices/${lowStockId}`, { token });

        // ---------------------------------------------------------- snapshots
        const snapshotDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productSnapshot.id, quantity: 2 }],
            },
        });
        const snapshotInvoice = snapshotDraft.json?.data?.invoice;
        await request('PUT', `/api/products/${productSnapshot.id}`, {
            token,
            body: { name: 'Snapshot Widget Renamed', price: 777, taxRate: 25 },
        });
        const snapshotAfterEdit = await request('GET', `/api/invoices/${snapshotInvoice.id}`, { token });
        check(
            'product edits do not change an existing invoice snapshot',
            snapshotAfterEdit.json?.data?.invoice?.items?.[0]?.productName === 'Snapshot Widget' &&
                snapshotAfterEdit.json?.data?.invoice?.items?.[0]?.unitPrice === 500 &&
                snapshotAfterEdit.json?.data?.invoice?.items?.[0]?.taxRate === 18 &&
                snapshotAfterEdit.json?.data?.invoice?.items?.[0]?.lineTax === 180
        );

        await request('PATCH', `/api/invoices/${snapshotInvoice.id}/issue`, { token });
        await request('PUT', `/api/products/${productSnapshot.id}`, {
            token,
            body: { name: 'Snapshot Widget Renamed Again', price: 888, taxRate: 30 },
        });
        const snapshotAfterIssue = await request('GET', `/api/invoices/${snapshotInvoice.id}`, { token });
        check(
            'issued invoice history keeps its snapshots',
            snapshotAfterIssue.json?.data?.invoice?.items?.[0]?.productName === 'Snapshot Widget' &&
                snapshotAfterIssue.json?.data?.invoice?.items?.[0]?.unitPrice === 500 &&
                snapshotAfterIssue.json?.data?.invoice?.items?.[0]?.taxRate === 18 &&
                snapshotAfterIssue.json?.data?.invoice?.items?.[0]?.lineTax === 180 &&
                snapshotAfterIssue.json?.data?.invoice?.status === 'issued'
        );

        const repriced = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productSnapshot.id, quantity: 1 }],
            },
        });
        const repricedId = repriced.json?.data?.invoice?.id;
        const repricedUpdate = await request('PUT', `/api/invoices/${repricedId}`, {
            token,
            body: { items: [{ productId: productSnapshot.id, quantity: 1 }] },
        });
        check(
            'draft edits re-read the current database price',
            repricedUpdate.status === 200 &&
                repricedUpdate.json?.data?.invoice?.items?.[0]?.unitPrice === 888
        );

        // ---------------------------------------------------------------- pay
        const paid = await request('PATCH', `/api/invoices/${mainInvoice.id}/pay`, { token });
        check('issued invoice can be marked paid', paid.status === 200 &&
            paid.json?.data?.invoice?.status === 'paid' &&
            paid.json?.data?.invoice?.paidAt !== null);
        const paidAgain = await request('PATCH', `/api/invoices/${mainInvoice.id}/pay`, { token });
        check('paying a paid invoice returns 409', paidAgain.status === 409, `status=${paidAgain.status}`);
        const issuePaid = await request('PATCH', `/api/invoices/${mainInvoice.id}/issue`, { token });
        check('issuing a paid invoice returns 409', issuePaid.status === 409, `status=${issuePaid.status}`);
        const cancelPaid = await request('PATCH', `/api/invoices/${mainInvoice.id}/cancel`, { token });
        check('cancelling a paid invoice returns 409', cancelPaid.status === 409, `status=${cancelPaid.status}`);
        const deletePaid = await request('DELETE', `/api/invoices/${mainInvoice.id}`, { token });
        check('deleting a paid invoice returns 409', deletePaid.status === 409, `status=${deletePaid.status}`);

        const partialDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });
        const partialId = partialDraft.json?.data?.invoice?.id;
        const partialIssued = await request('PATCH', `/api/invoices/${partialId}/issue`, { token });
        const firstPayment = await request('POST', `/api/invoices/${partialId}/payments`, {
            token,
            body: { amount: 4.25, paymentDate: today, method: 'cash' },
        });
        check(
            'partial payment records the received amount and remaining balance',
            partialIssued.status === 200 &&
                firstPayment.status === 201 &&
                firstPayment.json?.data?.invoice?.status === 'partially_paid' &&
                firstPayment.json?.data?.invoice?.financialSummary?.amountPaid === 4.25 &&
                firstPayment.json?.data?.invoice?.financialSummary?.outstanding === 6.75
        );
        const overpayment = await request('POST', `/api/invoices/${partialId}/payments`, {
            token,
            body: { amount: 6.76, paymentDate: today, method: 'cash' },
        });
        check('payment cannot exceed the outstanding balance', overpayment.status === 409, `status=${overpayment.status}`);
        const finalPayment = await request('POST', `/api/invoices/${partialId}/payments`, {
            token,
            body: { amount: 6.75, paymentDate: today, method: 'bank_transfer', reference: 'FINAL' },
        });
        check(
            'separate remaining payment settles the same invoice',
            finalPayment.status === 201 &&
                finalPayment.json?.data?.invoice?.status === 'paid' &&
                finalPayment.json?.data?.invoice?.financialSummary?.outstanding === 0 &&
                finalPayment.json?.data?.invoice?.payments?.length === 2
        );

        const returnInvoiceDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 2 }],
            },
        });
        const returnInvoiceId = returnInvoiceDraft.json?.data?.invoice?.id;
        const returnInvoiceIssued = await request('PATCH', `/api/invoices/${returnInvoiceId}/issue`, { token });
        const soldItem = returnInvoiceIssued.json?.data?.invoice?.items?.[0];
        const returnResponse = await request('POST', `/api/invoices/${returnInvoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'One item returned in saleable condition',
                items: [{ invoiceItemId: soldItem?.id, quantity: 1, disposition: 'saleable' }],
            },
        });
        const returnRecord = returnResponse.json?.data?.return;
        check(
            'physical return is recorded separately and starts pending',
            returnInvoiceIssued.status === 200 &&
                returnResponse.status === 201 &&
                returnRecord?.status === 'pending' &&
                returnRecord?.totalAmount === 11
        );
        const creditBeforeReturn = await request('GET', `/api/customers/${customer.id}/credit`, { token });
        const stockBeforeReturnApproval = await prisma.product.findUnique({
            where: { id: productB.id },
            select: { stockQuantity: true },
        });
        const returnApproved = await request(
            'PATCH',
            `/api/invoices/${returnInvoiceId}/returns/${returnRecord?.id}/approve`,
            { token }
        );
        check('approved saleable return is persisted and has a return number',
            returnApproved.status === 200 &&
                returnApproved.json?.data?.return?.status === 'approved' &&
                /^RET-\d+$/.test(returnApproved.json?.data?.return?.returnNumber || ''));
        const approvedReturnInvoice = await request('GET', `/api/invoices/${returnInvoiceId}`, { token });
        const creditAfterReturn = await request('GET', `/api/customers/${customer.id}/credit`, { token });
        check('approved returned quantity appears on the invoice line',
            returnApproved.json?.data?.return?.status === 'approved' &&
                returnApproved.json?.data?.return?.returnNumber?.startsWith('RET-') &&
                approvedReturnInvoice.json?.data?.invoice?.items?.[0]?.returnedQuantity === 1 &&
                approvedReturnInvoice.json?.data?.invoice?.items?.[0]?.returnable === 1
        );
        // Saleable units are restocked exactly once, at approval.
        const stockAfterReturnApproval = await prisma.product.findUnique({
            where: { id: productB.id },
            select: { stockQuantity: true },
        });
        check(
            'approving a saleable return restocks the product',
            stockAfterReturnApproval.stockQuantity === stockBeforeReturnApproval.stockQuantity + 1
        );
        check(
            'approved return reduces the unpaid balance without touching customer credit',
            creditAfterReturn.json?.data?.available === creditBeforeReturn.json?.data?.available &&
                approvedReturnInvoice.json?.data?.invoice?.returns?.[0]?.creditPendingPaisa === 0 &&
                approvedReturnInvoice.json?.data?.invoice?.financialSummary?.outstanding === 11 &&
                approvedReturnInvoice.json?.data?.invoice?.financialSummary?.creditsApplied === 0
        );
        const duplicateReturnApproval = await request(
            'PATCH',
            `/api/invoices/${returnInvoiceId}/returns/${returnRecord?.id}/approve`,
            { token }
        );
        check('an approved return cannot be approved again', duplicateReturnApproval.status === 409);
        const overReturn = await request('POST', `/api/invoices/${returnInvoiceId}/returns`, {
            token,
            body: {
                returnDate: today,
                reason: 'Exceeds remaining sold quantity',
                items: [{ invoiceItemId: soldItem?.id, quantity: 2, disposition: 'unsaleable' }],
            },
        });
        check('return request rejects quantity above the original sale',
            overReturn.status === 409, `status=${overReturn.status}`);

        // A rejected return needs a reason; the endpoint refuses an empty one.
        const rejectNoReason = await request(
            'PATCH',
            `/api/invoices/${returnInvoiceId}/returns/${returnRecord?.id}/reject`,
            { token, body: {} }
        );
        check('rejecting a return without a reason returns 400',
            rejectNoReason.status === 400, `status=${rejectNoReason.status}`);

        const payDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });
        const payDraftId = payDraft.json?.data?.invoice?.id;
        const payDraftResponse = await request('PATCH', `/api/invoices/${payDraftId}/pay`, { token });
        check('paying a draft invoice returns 409', payDraftResponse.status === 409, `status=${payDraftResponse.status}`);

        // ------------------------------------------------------------- cancel
        const cancelDraft = await request('PATCH', `/api/invoices/${payDraftId}/cancel`, { token });
        check('draft invoice can be cancelled', cancelDraft.status === 200 &&
            cancelDraft.json?.data?.invoice?.status === 'cancelled');
        const cancelAgain = await request('PATCH', `/api/invoices/${payDraftId}/cancel`, { token });
        check('cancelling a cancelled invoice returns 409', cancelAgain.status === 409, `status=${cancelAgain.status}`);
        const editCancelled = await request('PUT', `/api/invoices/${payDraftId}`, {
            token,
            body: { notes: 'x' },
        });
        check('editing a cancelled invoice returns 409', editCancelled.status === 409, `status=${editCancelled.status}`);
        const deleteCancelled = await request('DELETE', `/api/invoices/${payDraftId}`, { token });
        check('cancelled invoice can be deleted', deleteCancelled.status === 204, `status=${deleteCancelled.status}`);
        const deletedCancelledRead = await request('GET', `/api/invoices/${payDraftId}`, { token });
        check('deleted cancelled invoice is no longer found', deletedCancelledRead.status === 404, `status=${deletedCancelledRead.status}`);

        // ------------------------------------------------------------- delete
        const deleteDraft = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });
        const deleteDraftId = deleteDraft.json?.data?.invoice?.id;
        const deleted = await request('DELETE', `/api/invoices/${deleteDraftId}`, { token });
        check('draft invoice can be deleted', deleted.status === 204, `status=${deleted.status}`);
        const deletedRead = await request('GET', `/api/invoices/${deleteDraftId}`, { token });
        check('deleted draft is no longer found', deletedRead.status === 404, `status=${deletedRead.status}`);
        const deleteIssued = await request('DELETE', `/api/invoices/${snapshotInvoice.id}`, { token });
        check('deleting an issued invoice returns 409', deleteIssued.status === 409, `status=${deleteIssued.status}`);
        const missingDelete = await request('DELETE', '/api/invoices/2147483647', { token });
        check('deleting a missing invoice returns 404', missingDelete.status === 404, `status=${missingDelete.status}`);

        // ------------------------------------------------------------ overdue
        const overdue = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: dayOffset(-10),
                dueDate: dayOffset(-5),
                items: [{ productId: productB.id, quantity: 1 }],
            },
        });
        const overdueId = overdue.json?.data?.invoice?.id;
        const issuedOverdue = await request('PATCH', `/api/invoices/${overdueId}/issue`, { token });
        check('an issued invoice with a past due date is reported overdue', issuedOverdue.status === 200 &&
            issuedOverdue.json?.data?.invoice?.status === 'overdue');
        const overdueFilter = await request('GET', '/api/invoices?status=overdue&limit=100', { token });
        check('overdue filter returns the overdue invoice', overdueFilter.status === 200 &&
            overdueFilter.json?.data?.invoices?.some((invoice) => invoice.id === overdueId) &&
            overdueFilter.json.data.invoices.every((invoice) => invoice.status === 'overdue'));
        const issuedFilter = await request('GET', '/api/invoices?status=issued&limit=100', { token });
        check('issued filter excludes derived overdue invoices', issuedFilter.status === 200 &&
            !issuedFilter.json?.data?.invoices?.some((invoice) => invoice.id === overdueId));
        const payOverdue = await request('PATCH', `/api/invoices/${overdueId}/pay`, { token });
        check('an overdue invoice can be paid', payOverdue.status === 200 &&
            payOverdue.json?.data?.invoice?.status === 'paid');

        // ---------------------------------------------------- FK preservation
        const useSnapshotProduct = await request('POST', '/api/invoices', {
            token,
            body: {
                customerId: customer.id,
                invoiceDate: today,
                items: [{ productId: productSnapshot.id, quantity: 1 }],
            },
        });
        check('invoice referencing a product was created', useSnapshotProduct.status === 201);
        const blockedProduct = await request('DELETE', `/api/products/${productSnapshot.id}`, { token });
        check('deleting a product used by invoices returns 409', blockedProduct.status === 409, `status=${blockedProduct.status}`);
        const blockedCustomer = await request('DELETE', `/api/customers/${customer.id}`, { token });
        check('deleting a customer with invoices returns 409', blockedCustomer.status === 409, `status=${blockedCustomer.status}`);

        // --------------------------------------------------- existing modules
        const productList = await request('GET', '/api/products?limit=1', { token });
        const customerList = await request('GET', '/api/customers?limit=1', { token });
        check('product API still works', productList.status === 200 && productList.json?.data?.pagination?.limit === 1);
        check('customer API still works', customerList.status === 200 && customerList.json?.data?.pagination?.limit === 1);
    } finally {
        for (const id of [ownerId, otherId]) {
            if (!Number.isSafeInteger(id)) continue;
            await prisma.creditNote.deleteMany({ where: { invoice: { userId: id } } }).catch(() => {});
            await prisma.creditApplication.deleteMany({ where: { customer: { userId: id } } }).catch(() => {});
            await prisma.customerCreditEntry.deleteMany({ where: { customer: { userId: id } } }).catch(() => {});
            await prisma.returnCredit.deleteMany({ where: { invoice: { userId: id } } }).catch(() => {});
            await prisma.invoiceReturn.deleteMany({ where: { invoice: { userId: id } } }).catch(() => {});
            await prisma.payment.deleteMany({
                where: { invoice: { userId: id } },
            }).catch(() => {});
            await prisma.invoiceActivity.deleteMany({ where: { invoice: { userId: id } } }).catch(() => {});
            await prisma.invoice.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.product.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nInvoice API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nInvoice API test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
