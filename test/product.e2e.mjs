/**
 * End-to-end product API tests. Requires a running API and SQL Server database.
 *
 * The invoice-item foreign key does not exist yet (there are no invoice tables),
 * so the "referenced product cannot be deleted" case is proven with a
 * self-cleaning temporary table that is created and dropped by this test.
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const ownerEmail = `test.product.${stamp}@example.test`;
const otherEmail = `test.product.other.${stamp}@example.test`;
const results = [];
let ownerId;
let otherId;
let tempTableCreated = false;

const DROP_TEMP_TABLE = `IF OBJECT_ID(N'[dbo].[_ProductRefTest]', N'U') IS NOT NULL DROP TABLE [dbo].[_ProductRefTest];`;

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
            fullName: 'Product API Test',
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

async function createTempReferenceTable(productId) {
    await prisma.$executeRawUnsafe(DROP_TEMP_TABLE);
    await prisma.$executeRawUnsafe(`
        CREATE TABLE [dbo].[_ProductRefTest] (
            [id] INT NOT NULL IDENTITY(1,1),
            [productId] INT NOT NULL,
            CONSTRAINT [_ProductRefTest_pkey] PRIMARY KEY CLUSTERED ([id]),
            CONSTRAINT [_ProductRefTest_product_fkey] FOREIGN KEY ([productId])
                REFERENCES [dbo].[Products]([id]) ON DELETE NO ACTION
        );
    `);
    tempTableCreated = true;
    await prisma.$executeRaw`INSERT INTO [dbo].[_ProductRefTest] ([productId]) VALUES (${productId})`;
}

async function run() {
    let token;
    let otherToken;
    const baseCode = `PRD-${stamp}`;
    const fullCode = `SKU-${stamp}`;
    const inactiveCode = `OLD-${stamp}`;

    try {
        token = await createTestUser(ownerEmail, true);
        if (!token) throw new Error('Could not obtain an access token for the owner test user');
        otherToken = await createTestUser(otherEmail, false);

        const noAuth = await request('GET', '/api/products');
        check('unauthenticated product request returns 401', noAuth.status === 401, `status=${noAuth.status}`);

        for (const [label, body] of [
            ['name', { code: `MISS-${stamp}`, price: 10 }],
            ['code', { name: 'Missing Code', price: 10 }],
            ['price', { name: 'Missing Price', code: `MISS-${stamp}` }],
        ]) {
            const response = await request('POST', '/api/products', { token, body });
            check(`missing product ${label} returns 400`, response.status === 400, `status=${response.status}`);
        }

        for (const [label, body] of [
            ['price', { name: 'Negative Price', code: `NEG-${stamp}-P`, price: -1 }],
            ['tax rate', { name: 'Negative Tax', code: `NEG-${stamp}-T`, price: 1, taxRate: -1 }],
            ['stock quantity', { name: 'Negative Stock', code: `NEG-${stamp}-S`, price: 1, stockQuantity: -1 }],
            ['tax rate above 100', { name: 'High Tax', code: `NEG-${stamp}-H`, price: 1, taxRate: 101 }],
            ['price with 3 decimals', { name: 'Odd Price', code: `NEG-${stamp}-D`, price: 10.999 }],
            ['fractional stock', { name: 'Odd Stock', code: `NEG-${stamp}-F`, price: 1, stockQuantity: 1.5 }],
        ]) {
            const response = await request('POST', '/api/products', { token, body });
            check(`negative or invalid product ${label} returns 400`, response.status === 400, `status=${response.status}`);
        }

        const minimal = await request('POST', '/api/products', {
            token,
            body: { name: 'Minimal Widget', code: baseCode, price: 100 },
        });
        const minimalProduct = minimal.json?.data?.product;
        check('valid product create returns 201', minimal.status === 201, `status=${minimal.status}`);
        check(
            'optional fields default to zero/true/null',
            minimalProduct?.taxRate === 0 &&
                minimalProduct?.stockQuantity === 0 &&
                minimalProduct?.isActive === true &&
                minimalProduct?.description === null &&
                minimalProduct?.unit === null
        );
        check('decimal price is returned as a JSON number', typeof minimalProduct?.price === 'number' && minimalProduct.price === 100);

        const full = await request('POST', '/api/products', {
            token,
            body: {
                name: '  Heavy   Duty  Widget ',
                code: `  ${fullCode.toLowerCase()}  `,
                description: '  A very   sturdy widget  ',
                unit: '  BOX ',
                price: 123.45,
                taxRate: 18,
                stockQuantity: 10,
            },
        });
        const fullProduct = full.json?.data?.product;
        check('product with all fields returns 201', full.status === 201, `status=${full.status}`);
        check(
            'name and code are normalised, unit is lower-cased',
            fullProduct?.name === 'Heavy Duty Widget' &&
                fullProduct?.code === fullCode &&
                fullProduct?.unit === 'box' &&
                fullProduct?.description === 'A very   sturdy widget'
        );
        check('price, tax rate and stock are persisted', fullProduct?.price === 123.45 && fullProduct?.taxRate === 18 && fullProduct?.stockQuantity === 10);

        const duplicate = await request('POST', '/api/products', {
            token,
            body: { name: 'Duplicate Code', code: fullCode.toLowerCase(), price: 1 },
        });
        check('duplicate product code returns 409', duplicate.status === 409, `status=${duplicate.status}`);

        const otherUserProduct = await request('POST', '/api/products', {
            token: otherToken,
            body: { name: 'Other User Widget', code: fullCode, price: 5 },
        });
        check('the same code is allowed for a different owner', otherUserProduct.status === 201, `status=${otherUserProduct.status}`);

        const inactive = await request('POST', '/api/products', {
            token,
            body: { name: 'Discontinued Widget', code: inactiveCode, price: 50, isActive: false },
        });
        const inactiveProduct = inactive.json?.data?.product;
        check('product can be created inactive', inactive.status === 201 && inactiveProduct?.isActive === false, `status=${inactive.status}`);

        const list = await request('GET', '/api/products?page=1&limit=1', { token });
        const pagination = list.json?.data?.pagination;
        check('product list returns pagination metadata', list.status === 200 &&
            pagination?.page === 1 && pagination?.limit === 1 &&
            pagination?.total === 3 && pagination?.totalPages === 3);
        check('product list is newest first', list.json?.data?.products?.[0]?.id === inactiveProduct?.id);

        for (const [label, query] of [
            ['name', `search=heavy`],
            ['code', `search=${encodeURIComponent(fullCode.toLowerCase())}`],
            ['description', `search=sturdy`],
        ]) {
            const result = await request('GET', `/api/products?${query}`, { token });
            check(`product search matches ${label}`, result.status === 200 &&
                result.json?.data?.products?.some((product) => product.id === fullProduct?.id));
        }

        const inactiveFilter = await request('GET', '/api/products?isActive=false', { token });
        const activeFilter = await request('GET', '/api/products?isActive=true', { token });
        check('active-status filter returns inactive products only', inactiveFilter.status === 200 &&
            inactiveFilter.json?.data?.pagination?.total === 1);
        check('active-status filter returns active products only', activeFilter.status === 200 &&
            activeFilter.json?.data?.pagination?.total === 2);

        const unitFilter = await request('GET', '/api/products?unit=BOX', { token });
        check('unit filter is case-insensitive and returns matches', unitFilter.status === 200 &&
            unitFilter.json?.data?.pagination?.total === 1);

        for (const [label, query] of [
            ['page', 'page=0'],
            ['limit', 'limit=101'],
            ['active status', 'isActive=maybe'],
            ['unknown parameter', 'unknown=1'],
        ]) {
            const result = await request('GET', `/api/products?${query}`, { token });
            check(`invalid ${label} query returns 400`, result.status === 400, `status=${result.status}`);
        }

        const found = await request('GET', `/api/products/${fullProduct?.id}`, { token });
        check('get existing product returns 200', found.status === 200 && found.json?.data?.product?.id === fullProduct?.id);
        const missing = await request('GET', '/api/products/2147483647', { token });
        check('get missing product returns 404', missing.status === 404, `status=${missing.status}`);
        const invalidId = await request('GET', '/api/products/not-an-id', { token });
        check('invalid product ID returns 400', invalidId.status === 400, `status=${invalidId.status}`);

        const update = await request('PUT', `/api/products/${fullProduct?.id}`, {
            token,
            body: { name: '  Updated   Product ', price: 99.5, description: null },
        });
        check('product update returns normalised details', update.status === 200 &&
            update.json?.data?.product?.name === 'Updated Product' &&
            update.json?.data?.product?.price === 99.5 &&
            update.json?.data?.product?.description === null &&
            update.json?.data?.product?.code === fullCode);

        const duplicateUpdate = await request('PUT', `/api/products/${fullProduct?.id}`, {
            token,
            body: { code: baseCode },
        });
        check('updating a product to an existing code returns 409', duplicateUpdate.status === 409, `status=${duplicateUpdate.status}`);

        const massAssignment = await request('PUT', `/api/products/${fullProduct?.id}`, {
            token,
            body: { createdAt: new Date().toISOString() },
        });
        check('system-managed fields cannot be updated', massAssignment.status === 400, `status=${massAssignment.status}`);

        const emptyUpdate = await request('PUT', `/api/products/${fullProduct?.id}`, { token, body: {} });
        check('empty product update returns 400', emptyUpdate.status === 400, `status=${emptyUpdate.status}`);

        const missingUpdate = await request('PUT', '/api/products/2147483647', { token, body: { name: 'Nope' } });
        check('update missing product returns 404', missingUpdate.status === 404, `status=${missingUpdate.status}`);

        if (otherToken && Number.isSafeInteger(fullProduct?.id)) {
            const otherUserGet = await request('GET', `/api/products/${fullProduct.id}`, { token: otherToken });
            const otherUserList = await request('GET', '/api/products', { token: otherToken });
            check('product records are isolated by authenticated user', otherUserGet.status === 404 &&
                otherUserList.json?.data?.pagination?.total === 1);
        }

        const deactivate = await request('PATCH', `/api/products/${fullProduct?.id}/status`, {
            token,
            body: { isActive: false },
        });
        check('deactivating a product returns 200', deactivate.status === 200 && deactivate.json?.data?.product?.isActive === false);
        const inactiveAfter = await request('GET', '/api/products?isActive=false', { token });
        check('deactivated product appears in the inactive filter', inactiveAfter.json?.data?.pagination?.total === 2);

        const invalidStatus = await request('PATCH', `/api/products/${fullProduct?.id}/status`, {
            token,
            body: { isActive: 'false' },
        });
        check('non-boolean activation value returns 400', invalidStatus.status === 400, `status=${invalidStatus.status}`);

        const missingStatus = await request('PATCH', '/api/products/2147483647/status', {
            token,
            body: { isActive: true },
        });
        check('status update for a missing product returns 404', missingStatus.status === 404, `status=${missingStatus.status}`);

        const reactivate = await request('PATCH', `/api/products/${fullProduct?.id}/status`, {
            token,
            body: { isActive: true },
        });
        check('reactivating a product returns 200', reactivate.status === 200 && reactivate.json?.data?.product?.isActive === true);

        const deleted = await request('DELETE', `/api/products/${inactiveProduct?.id}`, { token });
        check('delete product without related records returns 204', deleted.status === 204, `status=${deleted.status}`);
        const deletedRead = await request('GET', `/api/products/${inactiveProduct?.id}`, { token });
        check('deleted product is no longer found', deletedRead.status === 404, `status=${deletedRead.status}`);

        const missingDelete = await request('DELETE', '/api/products/2147483647', { token });
        check('delete missing product returns 404', missingDelete.status === 404, `status=${missingDelete.status}`);

        await createTempReferenceTable(fullProduct.id);
        const blocked = await request('DELETE', `/api/products/${fullProduct.id}`, { token });
        check('delete blocked by related invoice records returns 409', blocked.status === 409, `status=${blocked.status}`);
        const preserved = await request('GET', `/api/products/${fullProduct.id}`, { token });
        check('product with related records is preserved', preserved.status === 200, `status=${preserved.status}`);

        await prisma.$executeRawUnsafe(DROP_TEMP_TABLE);
        tempTableCreated = false;
        const deletedAfterCleanup = await request('DELETE', `/api/products/${fullProduct.id}`, { token });
        check('product can be deleted once nothing references it', deletedAfterCleanup.status === 204, `status=${deletedAfterCleanup.status}`);
    } finally {
        if (tempTableCreated) {
            await prisma.$executeRawUnsafe(DROP_TEMP_TABLE).catch(() => {});
        }
        for (const id of [ownerId, otherId]) {
            if (!Number.isSafeInteger(id)) continue;
            await prisma.product.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.customer.deleteMany({ where: { userId: id } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id } }).catch(() => {});
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nProduct API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nProduct API test run failed:', error.message);
    if (tempTableCreated) {
        await prisma.$executeRawUnsafe(DROP_TEMP_TABLE).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
