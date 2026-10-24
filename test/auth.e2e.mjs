/**
 * End-to-end authentication tests.
 *
 * Runs against a live server (default http://localhost:5000) because the
 * behaviour under test spans Express middleware, validation, Prisma and
 * SQL Server. Start the API first:
 *
 *   npm run dev          (or: npm start)
 *   node test/auth.e2e.mjs
 */
import jwt from 'jsonwebtoken';
import config from '../src/config/index.js';
import prisma from '../src/db/prisma.js';

const BASE = process.env.API_BASE_URL || 'http://localhost:5000';

const results = [];

function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const mark = passed ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

function check(name, condition, detail = '') {
    record(name, Boolean(condition), condition ? detail : `EXPECTED-CONDITION-FAILED ${detail}`);
}

async function request(method, path, { body, rawBody, token, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (rawBody !== undefined) {
        init.body = rawBody;
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
    }

    if (token) init.headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${BASE}${path}`, init);
    const text = await response.text();

    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* non-JSON response */
    }

    return { status: response.status, json, text };
}

const containsSecret = (payload) => {
    const serialized = JSON.stringify(payload ?? {});
    return /passwordHash|password/i.test(serialized);
};

const run = async () => {
    const stamp = Date.now();
    const email = `test.auth.${stamp}@example.test`;
    const password = 'StrongPass!23';

    // ---------------------------------------------------------------- health
    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, `status=${health.status}`);
    check('health payload reports ok', health.json?.data?.status === 'ok');

    // ---------------------------------------------------------- 1. signup ok
    const signup = await request('POST', '/api/auth/signup', {
        body: {
            fullName: '  Hamna   Ali  ',
            email: `  ${email.toUpperCase()}  `,
            password,
            confirmPassword: password,
        },
    });
    check('1. successful signup returns 201', signup.status === 201, `status=${signup.status}`);
    check('1a. response contains user id + fullName + email', Boolean(signup.json?.data?.user?.id) && Boolean(signup.json?.data?.user?.fullName) && Boolean(signup.json?.data?.user?.email));
    check('1b. email normalised to lower-case/trimmed', signup.json?.data?.user?.email === email, `got=${signup.json?.data?.user?.email}`);
    check('1c. fullName trimmed and whitespace-collapsed', signup.json?.data?.user?.fullName === 'Hamna Ali', `got=${signup.json?.data?.user?.fullName}`);
    check('1d. signup response leaks no password/hash', !containsSecret(signup.json));

    // ------------------------------------------------ 2. duplicate email signup
    const duplicate = await request('POST', '/api/auth/signup', {
        body: {
            fullName: 'Someone Else',
            email: `  ${email.toUpperCase()}  `,
            password,
            confirmPassword: password,
        },
    });
    check('2. duplicate email signup returns 409', duplicate.status === 409, `status=${duplicate.status}`);

    // ------------------------------------------------------- 3. invalid email
    const badEmail = await request('POST', '/api/auth/signup', {
        body: { fullName: 'Bad Email', email: 'not-an-email', password, confirmPassword: password },
    });
    check('3. invalid email returns 400', badEmail.status === 400, `status=${badEmail.status}`);
    check('3a. error names the email field', JSON.stringify(badEmail.json?.errors ?? []).includes('email'));

    // -------------------------------------------------- 4. missing required fields
    const missing = await request('POST', '/api/auth/signup', { body: {} });
    const missingFields = (missing.json?.errors ?? []).map((e) => e.field).sort();
    check('4. missing required fields returns 400', missing.status === 400, `status=${missing.status}`);
    check(
        '4a. reports all four missing fields',
        JSON.stringify(missingFields) === JSON.stringify(['confirmPassword', 'email', 'fullName', 'password']),
        `fields=${missingFields.join(',')}`
    );

    // ----------------------------------------------------- 5. password mismatch
    const mismatch = await request('POST', '/api/auth/signup', {
        body: { fullName: 'Mismatch', email: `mismatch.${stamp}@example.test`, password, confirmPassword: 'DifferentPass!23' },
    });
    check('5. password mismatch returns 400', mismatch.status === 400, `status=${mismatch.status}`);
    check('5a. mismatch is attributed to confirmPassword', JSON.stringify(mismatch.json?.errors ?? []).includes('confirmPassword'));

    // ------------------------------------------------ 6. password below minimum
    const shortPassword = await request('POST', '/api/auth/signup', {
        body: { fullName: 'Short Pw', email: `short.${stamp}@example.test`, password: 'Short1!', confirmPassword: 'Short1!' },
    });
    check('6. password shorter than 8 chars returns 400', shortPassword.status === 400, `status=${shortPassword.status}`);
    check('6a. error names the password field', JSON.stringify(shortPassword.json?.errors ?? []).includes('password'));

    // ------------------------------------------------------- 7. successful sign-in
    const signin = await request('POST', '/api/auth/signin', { body: { email, password } });
    check('7. successful sign-in returns 200', signin.status === 200, `status=${signin.status}`);
    check('7a. returns a JWT', typeof signin.json?.data?.token === 'string' && signin.json.data.token.split('.').length === 3);
    check('7b. returns safe user info', signin.json?.data?.user?.email === email);
    check('7c. sign-in response leaks no password/hash', !containsSecret(signin.json));
    check('7d. token type is Bearer', signin.json?.data?.tokenType === 'Bearer', `tokenType=${signin.json?.data?.tokenType}`);

    const token = signin.json?.data?.token;

    // --------------------------------------------------------- 8. wrong password
    const wrongPassword = await request('POST', '/api/auth/signin', { body: { email, password: 'WrongPass!23' } });
    check('8. wrong password returns 401', wrongPassword.status === 401, `status=${wrongPassword.status}`);
    check('8a. wrong password message is generic', wrongPassword.json?.message === 'Invalid email or password', `message=${wrongPassword.json?.message}`);

    // ---------------------------------------------------------- 9. unknown email
    const unknownEmail = await request('POST', '/api/auth/signin', { body: { email: `nobody.${stamp}@example.test`, password } });
    check('9. unknown email returns 401', unknownEmail.status === 401, `status=${unknownEmail.status}`);
    check(
        '9a. unknown email message identical to wrong password (no enumeration)',
        unknownEmail.json?.message === wrongPassword.json?.message,
        `unknown="${unknownEmail.json?.message}" vs wrong="${wrongPassword.json?.message}"`
    );

    // --------------------------------------------------- 10. invalid request body
    const badJson = await request('POST', '/api/auth/signup', { rawBody: '{"fullName": "Broken", ' });
    check('10. malformed JSON returns 400', badJson.status === 400, `status=${badJson.status}`);
    check('10a. malformed JSON message is clear', badJson.json?.message === 'Invalid JSON in request body', `message=${badJson.json?.message}`);

    // ------------------------------------------- 11. token verification (valid)
    const me = await request('GET', '/api/auth/me', { token });
    check('11. valid token accepted by protected route', me.status === 200, `status=${me.status}`);
    check('11a. token subject matches created user', Number(me.json?.data?.user?.id) === signup.json?.data?.user?.id, `sub-id=${me.json?.data?.user?.id} vs ${signup.json?.data?.user?.id}`);

    // ------------------------------------------------------ 12. token expired
    const expired = jwt.sign({ sub: String(signup.json?.data?.user?.id), email }, config.jwt.secret, {
        algorithm: 'HS256',
        expiresIn: '-10s',
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
    });
    const expiredResult = await request('GET', '/api/auth/me', { token: expired });
    check('12. expired token rejected with 401', expiredResult.status === 401, `status=${expiredResult.status}`);
    check('12a. expiry is reported distinctly', expiredResult.json?.message === 'Token has expired', `message=${expiredResult.json?.message}`);

    // ------------------------------------------------ 13. token wrong signature
    const forged = jwt.sign({ sub: '1', email }, 'a-totally-different-secret-value', {
        algorithm: 'HS256',
        expiresIn: '1h',
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
    });
    const forgedResult = await request('GET', '/api/auth/me', { token: forged });
    check('13. token signed with wrong secret rejected', forgedResult.status === 401, `status=${forgedResult.status}`);

    // ----------------------------------------------- 14. missing/bad auth header
    const noAuth = await request('GET', '/api/auth/me');
    check('14. missing Authorization header returns 401', noAuth.status === 401, `status=${noAuth.status}`);
    const badScheme = await request('GET', '/api/auth/me', { headers: { Authorization: `Token ${token}` } });
    check('14a. non-Bearer scheme returns 401', badScheme.status === 401, `status=${badScheme.status}`);

    // ------------------------------------- 15. normalisation consistency on signin
    const mixedCaseSignin = await request('POST', '/api/auth/signin', {
        body: { email: `  ${email.toUpperCase()}  `, password },
    });
    check('15. sign-in accepts differently-cased/spaced email', mixedCaseSignin.status === 200, `status=${mixedCaseSignin.status}`);

    // ------------------------------------------------------------ 16. unknown route
    const notFound = await request('GET', '/api/does-not-exist');
    check('16. unknown route returns 404', notFound.status === 404, `status=${notFound.status}`);

    // ------------------------------- 17. password is stored hashed, not plaintext
    const stored = await prisma.user.findUnique({ where: { email }, select: { passwordHash: true, email: true } });
    check('17. password stored as a bcrypt hash', /^\$2[aby]\$\d{2}\$/.test(stored?.passwordHash ?? ''), `prefix=${String(stored?.passwordHash).slice(0, 7)}`);
    check('17a. plaintext password never stored', stored?.passwordHash !== password);

    // ----------------------------------------------------------------- cleanup
    const cleanup = await prisma.user.deleteMany({ where: { email } });
    console.log(`\nCleanup: removed ${cleanup.count} auth test account(s).`);

    await prisma.$disconnect();

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    console.log('\n================ SUMMARY ================');
    console.log(`Total: ${results.length}   Passed: ${passed}   Failed: ${failed}`);
    if (failed > 0) {
        console.log('\nFailures:');
        for (const r of results.filter((x) => !x.passed)) console.log(`  - ${r.name}: ${r.detail}`);
    }
    console.log('=========================================');

    process.exitCode = failed === 0 ? 0 : 1;
};

run().catch(async (error) => {
    console.error('\nTest run crashed:', error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
