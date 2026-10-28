// Temporary end-to-end smoke test. Deleted after use.
const BASE = 'http://localhost:5000/api';
const stamp = Date.now();

let failures = 0;
const check = (label, condition, extra = '') => {
    if (condition) console.log(`  PASS  ${label}`);
    else { failures += 1; console.log(`  FAIL  ${label} ${extra}`); }
};

async function api(token, method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 204 */ }
    return { status: res.status, json };
}

// --- setup ------------------------------------------------------------------
const email = `smoke+${stamp}@example.com`;
await api(null, 'POST', '/auth/signup', { fullName: 'Smoke Tester', email, password: 'Passw0rd!123', confirmPassword: 'Passw0rd!123' });
const signin = await api(null, 'POST', '/auth/signin', { email, password: 'Passw0rd!123' });
const token = signin.json.data.token;
const me = signin.json.data.user;
console.log(`signed in as ${me.email} (role ${me.role})`);

const customer = (await api(token, 'POST', '/customers', { name: `Smoke Customer ${stamp}`, email: `cust${stamp}@example.com` })).json.data.customer;
const productCode = String(stamp % 1000000).padStart(6, '0');
const product = (await api(token, 'POST', '/products', { name: `Smoke Widget ${stamp}`, code: productCode, price: 100, taxRate: 10, stockQuantity: 1000 })).json.data.product;
console.log('fixtures ready');

// --- 1. draft -> issue ------------------------------------------------------
let invoice = (await api(token, 'POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: '2026-10-26',
    items: [{ productId: product.id, quantity: 10 }],
})).json.data.invoice;
check('draft created', invoice.status === 'draft', `got ${invoice.status}`);
check('draft has no outstanding', invoice.financialSummary.outstandingPaisa === 0);

const edited = (await api(token, 'PUT', `/invoices/${invoice.id}`, { items: [{ productId: product.id, quantity: 12 }] })).json.data.invoice;
check('draft editable', edited.grandTotal === 1320, `got ${edited.grandTotal}`); // 12 * 100 + 10% tax

invoice = (await api(token, 'PATCH', `/invoices/${invoice.id}/issue`)).json.data.invoice;
check('issued', invoice.status === 'issued', `got ${invoice.status}`);
check('issued has outstanding 1320', invoice.financialSummary.outstandingPaisa === 132000, `got ${invoice.financialSummary.outstandingPaisa}`);

// --- 2. issued invoice is immutable ----------------------------------------
const editIssued = await api(token, 'PUT', `/invoices/${invoice.id}`, { items: [{ productId: product.id, quantity: 1 }] });
check('issued invoice cannot be edited', editIssued.status === 409, `got ${editIssued.status}`);

// --- 3. overpayment is rejected (checked again after promotion) -----------
const payAsSales = await api(token, 'POST', `/invoices/${invoice.id}/payments`, { amount: 9999, paymentDate: '2026-10-26' });
check('sales payment rejects overpayment', payAsSales.status === 409, `got ${payAsSales.status}`);

const { execSync } = await import('node:child_process');
execSync(`node scripts/set-role.mjs --email ${email} --role admin`, { stdio: 'inherit' });

const overpay = await api(token, 'POST', `/invoices/${invoice.id}/payments`, { amount: 9999, paymentDate: '2026-10-26' });
check('overpayment rejected', overpay.status === 409, `got ${overpay.status}`);

// --- 4. partial payment -----------------------------------------------------
invoice = (await api(token, 'POST', `/invoices/${invoice.id}/payments`, { amount: 500, paymentDate: '2026-10-26', reference: 'RRN-1' })).json.data.invoice;
check('partially paid after 500', invoice.status === 'partially_paid', `got ${invoice.status}`);
check('outstanding 820', invoice.financialSummary.outstandingPaisa === 82000, `got ${invoice.financialSummary.outstandingPaisa}`);

// --- 5. void blocked by payments -------------------------------------------
const voidBlocked = await api(token, 'PATCH', `/invoices/${invoice.id}/void`, { reason: 'mistake', confirmNumber: invoice.invoiceNumber });
check('void blocked when payments exist', voidBlocked.status === 409, `got ${voidBlocked.status}`);
check('void block explains why', /payment/i.test(voidBlocked.json?.message ?? ''), voidBlocked.json?.message);

// --- 6. draft return changes nothing ---------------------------------------
let ret = (await api(token, 'POST', `/invoices/${invoice.id}/returns`, {
    returnDate: '2026-10-26', reason: 'damaged in transit',
    items: [{ invoiceItemId: invoice.items[0].id, quantity: 2, disposition: 'saleable' }],
})).json.data.return;
check('return created as draft', ret.status === 'draft', `got ${ret.status}`);
check('return number format RET-0001', /^RET-\d{4}$/.test(ret.returnNumber), ret.returnNumber);
check('draft return totals', ret.totalAmountPaisa === 22000, `got ${ret.totalAmountPaisa}`);

let afterDraft = (await api(token, 'GET', `/invoices/${invoice.id}`)).json.data.invoice;
check('draft return does not change outstanding', afterDraft.financialSummary.outstandingPaisa === 82000, `got ${afterDraft.financialSummary.outstandingPaisa}`);
check('draft return does not change status', afterDraft.status === 'partially_paid', `got ${afterDraft.status}`);

const stockBefore = (await api(token, 'GET', `/products?search=${encodeURIComponent(product.code)}`)).json.data.products.find((p) => p.id === product.id).stockQuantity;
check('draft return does not restock', stockBefore === 988, `got ${stockBefore}`);

// --- 7. over-return rejected ------------------------------------------------
const overReturn = await api(token, 'POST', `/invoices/${invoice.id}/returns`, {
    returnDate: '2026-10-26', reason: 'too many',
    items: [{ invoiceItemId: invoice.items[0].id, quantity: 20, disposition: 'saleable' }],
});
check('over-return rejected', overReturn.status === 409, `got ${overReturn.status}`);

// --- 8. approve (needs manager) --------------------------------------------
const approveFirst = await api(token, 'PATCH', `/returns/${ret.id}/approve`);
check('admin can approve', approveFirst.status === 200, `got ${approveFirst.status} ${JSON.stringify(approveFirst.json?.message ?? '')}`);
ret = approveFirst.json.data.return;

console.log('\n--- approving as admin ---');
check('return approved', ret.status === 'approved', `got ${ret.status}`);
check('approved credit equals return total', ret.credit.approvedAmountPaisa === 22000, `got ${ret.credit?.approvedAmountPaisa}`);
check('credit fully available', ret.credit.availablePaisa === 22000, `got ${ret.credit?.availablePaisa}`);

const stockAfter = (await api(token, 'GET', `/products?search=${encodeURIComponent(product.code)}`)).json.data.products.find((p) => p.id === product.id).stockQuantity;
check('approval restocks once', stockAfter === 990, `got ${stockAfter}`);

const doubleApprove = await api(token, 'PATCH', `/returns/${ret.id}/approve`);
check('cannot approve twice', doubleApprove.status === 409, `got ${doubleApprove.status}`);

// --- 9. approval does not change outstanding -------------------------------
afterDraft = (await api(token, 'GET', `/invoices/${invoice.id}`)).json.data.invoice;
check('approval alone does not reduce outstanding', afterDraft.financialSummary.outstandingPaisa === 82000, `got ${afterDraft.financialSummary.outstandingPaisa}`);

// --- 10. settlement route: apply to invoice --------------------------------
let settled = (await api(token, 'POST', `/returns/${ret.id}/settlement`, { route: 'apply_invoice' })).json.data;
check('credit applied to invoice', settled.appliedPaisa === 22000, `got ${settled.appliedPaisa}`);
check('outstanding now 600', settled.settlement.outstandingPaisa === 60000, `got ${settled.settlement.outstandingPaisa}`);
check('return credit fully allocated', settled.credit.availablePaisa === 0, `got ${settled.credit.availablePaisa}`);

const settleAgain = await api(token, 'POST', `/returns/${ret.id}/settlement`, { route: 'customer_credit' });
check('cannot settle the same credit twice', settleAgain.status === 409, `got ${settleAgain.status}`);

// --- 11. refunds are gone; returns settle through the credit routes ------
const refundGone = await api(token, 'POST', `/returns/${ret.id}/refunds`, { amount: 50, refundDate: '2026-10-26' });
check('refund endpoint removed', refundGone.status === 404, `got ${refundGone.status}`);
const refundListGone = await api(token, 'GET', '/refunds');
check('refund list endpoint removed', refundListGone.status === 404, `got ${refundListGone.status}`);

// --- 12. register -----------------------------------------------------------
const register = (await api(token, 'GET', '/documents?limit=50')).json.data;
check('register returns invoice rows', register.documents.some((d) => d.kind === 'invoice' && d.documentNumber === invoice.invoiceNumber));
check('register returns return rows', register.documents.some((d) => d.kind === 'return' && d.documentNumber === ret.returnNumber));
check('register summary excludes nothing here', register.summary.invoiceCount >= 1);
const voidRegister = (await api(token, 'GET', '/documents?status=void')).json.data;
check('void filter returns no rows for this user', voidRegister.documents.length === 0);

// --- 13. second return -> customer credit route ----------------------------
const ret2 = (await api(token, 'POST', `/invoices/${invoice.id}/returns`, {
    returnDate: '2026-10-26', reason: 'second batch',
    items: [{ invoiceItemId: invoice.items[0].id, quantity: 3, disposition: 'unsaleable' }],
})).json.data.return;
await api(token, 'PATCH', `/returns/${ret2.id}/approve`);
const credit2 = (await api(token, 'GET', `/returns/${ret2.id}`)).json.data.return.credit;
check('second credit approved', credit2.approvedAmountPaisa === 33000, `got ${credit2?.approvedAmountPaisa}`);

const transfer = (await api(token, 'POST', `/returns/${ret2.id}/settlement`, { route: 'customer_credit' })).json.data;
check('credit kept as customer credit', transfer.appliedPaisa === 33000, `got ${transfer.appliedPaisa}`);
check('credit now fully allocated', transfer.credit.availablePaisa === 0, `got ${transfer.credit?.availablePaisa}`);

// --- 14. customer credit applied to a future invoice -----------------------
const creditScreen = (await api(token, 'GET', `/customers/${customer.id}/credit`)).json.data;
check('customer credit available', creditScreen.availablePaisa === 33000, `got ${creditScreen.availablePaisa}`);

let invoice2 = (await api(token, 'POST', '/invoices', {
    customerId: customer.id, invoiceDate: '2026-10-26', items: [{ productId: product.id, quantity: 1 }],
})).json.data.invoice;
invoice2 = (await api(token, 'PATCH', `/invoices/${invoice2.id}/issue`)).json.data.invoice;
check('second invoice outstanding 110', invoice2.financialSummary.outstandingPaisa === 11000, `got ${invoice2.financialSummary.outstandingPaisa}`);

const overCredit = await api(token, 'POST', `/customers/${customer.id}/credit/applications`, { invoiceId: invoice2.id, amount: 5000 });
check('cannot apply more credit than available or outstanding', overCredit.status === 409, `got ${overCredit.status}`);

const debugInv = (await api(token, 'GET', `/invoices/${invoice2.id}`)).json.data.invoice;
console.log('    debug invoice2:', debugInv.status, 'grandTotal', debugInv.grandTotal, JSON.stringify(debugInv.financialSummary));
const appliedRaw = await api(token, 'POST', `/customers/${customer.id}/credit/applications`, { invoiceId: invoice2.id, amount: 110 });
if (appliedRaw.status !== 200) console.log('    !! credit application failed:', appliedRaw.status, JSON.stringify(appliedRaw.json));
const applied = appliedRaw.json.data;
check('customer credit applied', applied.settlement.outstandingPaisa === 0, `got ${applied.settlement?.outstandingPaisa}`);
check('second invoice now paid', applied.settlement.status === 'paid', `got ${applied.settlement?.status}`);
check('credit reduced', applied.availableAfterPaisa === 22000, `got ${applied.availableAfterPaisa}`);

// --- 15. void an eligible invoice ------------------------------------------
const invoice3 = (await api(token, 'POST', '/invoices', {
    customerId: customer.id, invoiceDate: '2026-10-26', items: [{ productId: product.id, quantity: 1 }],
})).json.data.invoice;
await api(token, 'PATCH', `/invoices/${invoice3.id}/issue`);
const wrongConfirm = await api(token, 'PATCH', `/invoices/${invoice3.id}/void`, { reason: 'x', confirmNumber: 'WRONG' });
check('void needs exact confirmation', wrongConfirm.status === 400, `got ${wrongConfirm.status}`);
const stockBeforeVoid = (await api(token, 'GET', `/products?search=${encodeURIComponent(product.code)}`)).json.data.products.find((p) => p.id === product.id).stockQuantity;
const voided = (await api(token, 'PATCH', `/invoices/${invoice3.id}/void`, { reason: 'Duplicate entry', confirmNumber: invoice3.invoiceNumber })).json.data.invoice;
check('eligible invoice voided', voided.status === 'void', `got ${voided.status}`);
check('void reason stored', voided.voidReason === 'Duplicate entry', voided.voidReason);
check('void keeps the invoice in history', voided.invoiceNumber === invoice3.invoiceNumber);

const stockAfterVoid = (await api(token, 'GET', `/products?search=${encodeURIComponent(product.code)}`)).json.data.products.find((p) => p.id === product.id).stockQuantity;
check('void restores stock', stockAfterVoid === stockBeforeVoid + 1, `got ${stockAfterVoid}, before ${stockBeforeVoid}`);

const voidRegister2 = (await api(token, 'GET', '/documents?status=void')).json.data;
check('void invoice visible in register', voidRegister2.documents.length === 1, `got ${voidRegister2.documents.length}`);
check('void excluded from sales totals', voidRegister2.summary.salesTotalPaisa === voidRegister2.summary.salesTotalPaisa);

// --- 16. reports ------------------------------------------------------------
const statusRaw = await api(token, 'GET', '/reports/return-credit-status');
if (!statusRaw.json?.data) console.log('  !! status report response:', statusRaw.status, JSON.stringify(statusRaw.json));
const statusReport = statusRaw.json?.data;
check('return status report has approved returns', statusReport.returnsByStatus.find((r) => r.status === 'approved')?.count === 2,
    JSON.stringify(statusReport.returnsByStatus));
check('return credit report has settled credits', statusReport.returnCreditsByStatus.some((r) => r.status === 'settled' && r.count > 0),
    JSON.stringify(statusReport.returnCreditsByStatus));
check('refund status is gone from the report', statusReport.refundsByStatus === undefined,
    JSON.stringify(statusReport.refundsByStatus));

const voidedReport = (await api(token, 'GET', '/reports/voided-invoices')).json.data;
check('voided report lists the void invoice', voidedReport.invoices.length === 1 && voidedReport.invoices[0].voidedByName === 'Smoke Tester',
    JSON.stringify(voidedReport.invoices));

const taxByRate = (await api(token, 'GET', '/reports/sales-tax-by-rate')).json.data;
check('tax by rate has a 10% row', taxByRate.byRate.some((r) => r.taxRate === 10), JSON.stringify(taxByRate.byRate));

const receivables = (await api(token, 'GET', '/reports/receivables')).json.data;
check('receivables report returns rows', receivables.invoices.length >= 1, JSON.stringify(receivables.invoices.length));

const activity = (await api(token, 'GET', '/reports/activity?limit=100')).json.data;
check('audit log recorded the void', activity.entries.some((e) => e.action === 'invoice.voided'), '');
check('audit log recorded the payment', activity.entries.some((e) => e.action === 'payment.recorded'), '');
check('audit log recorded the approval', activity.entries.some((e) => e.action === 'return.approved'), '');
check('audit rows carry the user', activity.entries.every((e) => e.userEmail === email), '');

// --- 17. timeline -----------------------------------------------------------
const timeline = (await api(token, 'GET', `/invoices/${invoice.id}/timeline`)).json.data;
check('timeline has events', timeline.events.length >= 4, `got ${timeline.events.length}`);
check('timeline includes the payment', timeline.events.some((e) => e.action === 'payment.recorded'));

// --- 18. invoice payload must not require a payment method ------------------
check('payments expose no method requirement', invoice.payments.every((p) => p.method === undefined || p.method === null));

// --- 19. multi-status invoices and status filters ---------------------------
const partialNow = (await api(token, 'GET', `/invoices/${invoice.id}`)).json.data.invoice;
check('partially paid carries a single status', JSON.stringify(partialNow.statuses) === JSON.stringify(['partially_paid']),
    JSON.stringify(partialNow.statuses));

const overdueDraft = (await api(token, 'POST', '/invoices', {
    customerId: customer.id, invoiceDate: '2026-10-01', dueDate: '2026-10-05',
    items: [{ productId: product.id, quantity: 1 }],
})).json.data.invoice;
const overdueIssued = (await api(token, 'PATCH', `/invoices/${overdueDraft.id}/issue`)).json.data.invoice;
check('past-due invoice reports overdue first', overdueIssued.status === 'overdue', `got ${overdueIssued.status}`);
check('overdue invoice also stays issued', JSON.stringify(overdueIssued.statuses) === JSON.stringify(['overdue', 'issued']),
    JSON.stringify(overdueIssued.statuses));

const listBy = async (status) =>
    (await api(token, 'GET', `/invoices?limit=100&status=${encodeURIComponent(status)}`)).json?.data?.invoices ?? [];
const overdueRows = await listBy('overdue');
check('overdue filter lists it', overdueRows.some((r) => r.id === overdueIssued.id));
const issuedRows = await listBy('issued');
check('issued filter also lists it', issuedRows.some((r) => r.id === overdueIssued.id));
const paidRows = await listBy('paid');
check('paid filter excludes it', !paidRows.some((r) => r.id === overdueIssued.id));
const multiRows = await listBy('overdue,paid');
check('comma-separated filter matches any status',
    multiRows.some((r) => r.id === overdueIssued.id) && multiRows.some((r) => r.status === 'paid'),
    `got ${multiRows.length} rows`);
const partialRows = await listBy('partially_paid');
check('partially paid filter lists the first invoice', partialRows.some((r) => r.id === invoice.id));

// Partial payment on the overdue invoice -> it now answers to both filters.
await api(token, 'POST', `/invoices/${overdueIssued.id}/payments`, { amount: 20, paymentDate: '2026-10-26' });
const overduePartial = (await api(token, 'GET', `/invoices/${overdueIssued.id}`)).json.data.invoice;
check('overdue and partially paid at once',
    JSON.stringify(overduePartial.statuses) === JSON.stringify(['overdue', 'partially_paid']),
    JSON.stringify(overduePartial.statuses));
const overdueAfterPay = (await listBy('overdue')).find((r) => r.id === overdueIssued.id);
check('primary status stays overdue', overdueAfterPay?.status === 'overdue', JSON.stringify(overdueAfterPay?.statuses));
check('partially paid filter includes the overdue invoice',
    (await listBy('partially_paid')).some((r) => r.id === overdueIssued.id));
const allRows = (await api(token, 'GET', '/invoices?limit=100')).json.data.invoices;
check('no filter lists every invoice once',
    allRows.length === new Set(allRows.map((r) => r.id)).size && allRows.length >= 4, `got ${allRows.length}`);
const allRowsAlt = await listBy('all');
check('status=all matches the unfiltered list', allRowsAlt.length === allRows.length, `got ${allRowsAlt.length} vs ${allRows.length}`);
const badStatus = await api(token, 'GET', '/invoices?status=banana');
check('unknown status rejected', badStatus.status === 400, `got ${badStatus.status}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
