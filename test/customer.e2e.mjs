/**
 * End-to-end customer API tests. Requires a running API and SQL Server database.
 */
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const stamp = Date.now();
const password = 'StrongPass!23';
const email = `test.customer.${stamp}@example.test`;
const otherEmail = `test.customer.other.${stamp}@example.test`;
const results = [];
let userId;
let otherUserId;

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
        // A 204 response has no body.
    }
    return { status: response.status, json };
}

async function createTestUser(address) {
    const signup = await request('POST', '/api/auth/signup', {
        body: {
            fullName: 'Customer API Test',
            email: address,
            password,
            confirmPassword: password,
        },
    });
    check(`signup test user (${address === email ? 'owner' : 'second user'})`, signup.status === 201, `status=${signup.status}`);
    const id = signup.json?.data?.user?.id;
    if (Number.isSafeInteger(id)) {
        if (address === email) userId = id;
        else otherUserId = id;
    }

    const signin = await request('POST', '/api/auth/signin', {
        body: { email: address, password },
    });
    check(`signin test user (${address === email ? 'owner' : 'second user'})`, signin.status === 200, `status=${signin.status}`);
    return signin.json?.data?.token;
}

async function run() {
    let token;
    let otherToken;

    try {
        token = await createTestUser(email);
        if (!token) throw new Error('Could not obtain an access token for the owner test user');
        otherToken = await createTestUser(otherEmail);

        const noAuth = await request('GET', '/api/customers');
        check('unauthenticated customer request returns 401', noAuth.status === 401, `status=${noAuth.status}`);

        const missingName = await request('POST', '/api/customers', {
            token,
            body: { email: 'name.required@example.test' },
        });
        check('missing customer name returns 400', missingName.status === 400, `status=${missingName.status}`);

        const invalidEmail = await request('POST', '/api/customers', {
            token,
            body: { name: 'Invalid Email', email: 'not-an-email' },
        });
        check('invalid customer email returns 400', invalidEmail.status === 400, `status=${invalidEmail.status}`);

        const invalidRegistration = await request('POST', '/api/customers', {
            token,
            body: { name: 'Invalid Registration', registration: 'Unknown' },
        });
        check('invalid customer registration returns 400', invalidRegistration.status === 400, `status=${invalidRegistration.status}`);

        const first = await request('POST', '/api/customers', {
            token,
            body: {
                name: '  Search   Name Probe ',
                registration: 'Registered',
                email: ` MailProbe${stamp}@Example.Test `,
                phone: `PhoneProbe${stamp}`,
                companyName: `CompanyProbe${stamp}`,
                city: 'Lahore',
                notes: '  first customer  ',
            },
        });
        check('valid customer create returns 201', first.status === 201, `status=${first.status}`);
        const firstCustomer = first.json?.data?.customer;
        check('create trims name, normalizes email and optional text', firstCustomer?.name === 'Search Name Probe' &&
            firstCustomer?.email === `mailprobe${stamp}@example.test` && firstCustomer?.notes === 'first customer');
        check('customer registration status is persisted', firstCustomer?.registration === 'Registered');

        const second = await request('POST', '/api/customers', {
            token,
            body: { name: 'Second City Customer', city: 'Karachi', email: '' },
        });
        check('empty optional email is stored as null', second.status === 201 &&
            second.json?.data?.customer?.email === null, `status=${second.status}`);

        const third = await request('POST', '/api/customers', {
            token,
            body: { name: 'Third Lahore Customer', city: 'Lahore' },
        });
        check('additional customer create returns 201', third.status === 201, `status=${third.status}`);

        const list = await request('GET', '/api/customers?page=1&limit=1', { token });
        check('customer list returns pagination metadata', list.status === 200 &&
            list.json?.data?.pagination?.page === 1 && list.json?.data?.pagination?.limit === 1 &&
            list.json?.data?.pagination?.total === 3 && list.json?.data?.pagination?.totalPages === 3);

        const invalidPage = await request('GET', '/api/customers?page=0', { token });
        const excessiveLimit = await request('GET', '/api/customers?limit=101', { token });
        check('invalid page query returns 400', invalidPage.status === 400, `status=${invalidPage.status}`);
        check('limit above the maximum returns 400', excessiveLimit.status === 400, `status=${excessiveLimit.status}`);

        for (const [field, value] of [
            ['name', `Name Probe`],
            ['email', `MailProbe${stamp}`],
            ['phone', `PhoneProbe${stamp}`],
            ['companyName', `CompanyProbe${stamp}`],
        ]) {
            const result = await request('GET', `/api/customers?search=${encodeURIComponent(value)}`, { token });
            check(`customer search matches ${field}`, result.status === 200 &&
                result.json?.data?.customers?.some((customer) => customer.id === firstCustomer?.id));
        }

        const city = await request('GET', '/api/customers?city=Lahore', { token });
        check('city filter returns matching customers', city.status === 200 &&
            city.json?.data?.pagination?.total === 2);

        const found = await request('GET', `/api/customers/${firstCustomer?.id}`, { token });
        check('get existing customer returns 200', found.status === 200 &&
            found.json?.data?.customer?.id === firstCustomer?.id);

        const missing = await request('GET', '/api/customers/2147483647', { token });
        check('get missing customer returns 404', missing.status === 404, `status=${missing.status}`);
        const invalidId = await request('GET', '/api/customers/not-an-id', { token });
        check('invalid customer ID returns 400', invalidId.status === 400, `status=${invalidId.status}`);

        const update = await request('PUT', `/api/customers/${firstCustomer?.id}`, {
            token,
            body: { name: 'Updated Customer', email: '  UPDATED@Example.Test ', phone: '555-0100', registration: 'Unregistered' },
        });
        check('customer update returns normalized details', update.status === 200 &&
            update.json?.data?.customer?.name === 'Updated Customer' &&
            update.json?.data?.customer?.email === 'updated@example.test' &&
            update.json?.data?.customer?.phone === '555-0100' &&
            update.json?.data?.customer?.registration === 'Unregistered');

        const massAssignment = await request('PUT', `/api/customers/${firstCustomer?.id}`, {
            token,
            body: { createdAt: new Date().toISOString() },
        });
        check('system-managed fields cannot be updated', massAssignment.status === 400, `status=${massAssignment.status}`);

        if (otherToken && Number.isSafeInteger(firstCustomer?.id)) {
            const otherUserGet = await request('GET', `/api/customers/${firstCustomer.id}`, { token: otherToken });
            const otherUserList = await request('GET', '/api/customers', { token: otherToken });
            check('customer records are isolated by authenticated user', otherUserGet.status === 404 &&
                otherUserList.json?.data?.pagination?.total === 0);
        }

        const deletedId = second.json?.data?.customer?.id;
        const deleted = await request('DELETE', `/api/customers/${deletedId}`, { token });
        check('delete customer without related records returns 204', deleted.status === 204, `status=${deleted.status}`);
        const deletedRead = await request('GET', `/api/customers/${deletedId}`, { token });
        check('deleted customer is no longer found', deletedRead.status === 404, `status=${deletedRead.status}`);

        const missingDelete = await request('DELETE', '/api/customers/2147483647', { token });
        check('delete missing customer returns 404', missingDelete.status === 404, `status=${missingDelete.status}`);
    } finally {
        for (const id of [userId, otherUserId]) {
            if (!Number.isSafeInteger(id)) continue;
            await prisma.customer.deleteMany({ where: { userId: id } });
            await prisma.user.deleteMany({ where: { id } });
        }
        await prisma.$disconnect();
    }

    const failed = results.filter((result) => !result.passed);
    console.log(`\nCustomer API tests: ${results.length - failed.length} passed, ${failed.length} failed.`);
    if (failed.length) process.exitCode = 1;
}

run().catch(async (error) => {
    console.error('\nCustomer API test run failed:', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
