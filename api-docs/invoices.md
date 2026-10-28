# Invoice API — frontend contract

Base path: `/invoices`

## List
GET `/invoices?page=1&limit=20&search=&status=&customerId=&from=&to=`
Response:
```json
{
  "invoices": [ ... ],
  "statusCounts": { "all": 0, "draft": 0, "issued": 0, "partially_paid": 0, "paid": 0, "overdue": 0, "cancelled": 0, "void": 0, "credit": 0, "return": 0 },
  "pagination": { "total": 0, "page": 1, "limit": 20, "totalPages": 1 }
}
```

## Create draft
POST `/invoices`
Body:
```json
{
  "customerId": 123,
  "invoiceDate": "2026-10-27",
  "dueDate": "2026-11-26",
  "notes": "optional",
  "items": [
    { "productId": 1, "quantity": 2 }
  ]
}
```
Response: `{ "invoice": { ... }, "success": true, "message": "Invoice draft created successfully" }`

## Get by id
GET `/invoices/:id`
Response: `{ "invoice": { ... }, "success": true }`

## Issue
PATCH `/invoices/:id/issue`
Response: `{ "invoice": { ... }, "success": true, "message": "Invoice issued successfully" }`

## Mark paid (full balance)
PATCH `/invoices/:id/pay`
Response: `{ "invoice": { ... }, "success": true, "message": "Invoice marked as paid" }`

## Record payment
POST `/invoices/:id/payments`
Body:
```json
{
  "amount": 5000.00,
  "creditAmount": 0,
  "paymentDate": "2026-10-27",
  "method": "Cash",
  "reference": "optional",
  "notes": "optional",
  "creditReason": "required when creditAmount > 0",
  "idempotencyKey": "optional client-generated key",
  "expectedVersion": 1
}
```
Notes:
- `amount` and `creditAmount` are in the same currency units the backend uses (it converts to integer paisa server-side).
- At least one of `amount` or `creditAmount` must be > 0.
- `creditAmount` may only be issued from excess cash; the backend rejects over-credit with 409.
- If `creditAmount > 0`, `creditReason` is required.
- On conflict (state, stale version) the backend answers 409.
Response on success: `{ "invoice": { ... }, "replayed": false, "success": true, "message": "Payment recorded successfully" }`
If idempotency key replayed: status 200, `"replayed": true`, `"message": "Payment already recorded"`.

## Update payment
PATCH `/invoices/:id/payments/:paymentId`
Body: `{ "amount": 1000, "paymentDate": "2026-10-27", "notes": "optional" }`

## Cancel draft/issued
PATCH `/invoices/:id/cancel`
Requires permission `invoice.cancel`.

## Void
PATCH `/invoices/:id/void`
Body: `{ "reason": "...", "confirmNumber": "type INV-xxxx exactly" }`
Requires permission `invoice.void`.

## Delete draft/cancelled
DELETE `/invoices/:id`

## Returns (attached to an invoice)
POST `/invoices/:id/returns`
Body:
```json
{
  "returnDate": "2026-10-27",
  "reason": "...",
  "items": [
    { "invoiceItemId": 10, "quantity": 1, "disposition": "saleable" }
  ]
}
```
PATCH `/invoices/:id/returns/:returnId` — same shape.
PATCH `/invoices/:id/returns/:returnId/approve` — settles the return in one transaction: credit clawback, unpaid reduction, leftover to customer return credit.
PATCH `/invoices/:id/returns/:returnId/reject` — body: `{ "reason": "..." }`

## Invoice shape (what the backend returns)
- `id`, `invoiceNumber`, `customerId`, `customer` (object), `invoiceDate`, `dueDate`, `status`, `statuses`, `editable`, `allowedActions`
- `subtotal`, `taxTotal`, `grandTotal`, `notes`
- `paidAt`, `issuedAt`, `issuedBy`, `issuedByName`, `voidedAt`, `voidReason`, `voidedBy`, `voidedByName`, `createdAt`, `updatedAt`, `version`
- `preparedBy`: `{ name, email }`
- `items`: each item has `id, productId, productName, productCode, quantity, unitPrice, taxRate, lineSubtotal, lineTax, lineTotal, returnedQuantity, pendingReturnQuantity, returnable`
- `payments`: each payment has `id, paymentDate, amount, method, reference, status, notes, recordedByName`
- `activities`: each activity has `id, eventType, description, amount, createdAt, actorName`
- `returns`: each return has `id, returnNumber, returnDate, reason, status, subtotal, taxTotal, totalAmount, creditApprovedPaisa, creditPending, creditPendingPaisa, items: [{ id, invoiceItemId, productName, productCode, quantity, unitPrice, taxRate, subtotal, taxAmount, totalAmount }]`
- `creditNotes`: each note has `id, returnId, creditNumber, issueDate, reason, subtotal, taxTotal, totalAmount, appliedAmount, unappliedAmount`
- `creditApplications`: each application has `id, amount, appliedAt, appliedByName`
- `financialSummary`:
  ```json
  {
    "invoiceTotal": "string",
    "paid": "string",
    "creditIssued": "string",
    "creditApplied": "string",
    "returnValue": "string",
    "outstanding": "string",
    "invoiceTotalPaisa": 0,
    "paidPaisa": 0,
    "creditIssuedPaisa": 0,
    "creditAppliedPaisa": 0,
    "returnValuePaisa": 0,
    "outstandingPaisa": 0
  }
  ```
- `accountSummary`:
  ```json
  {
    "invoiceTotal": "string",
    "completedPayments": "string",
    "creditIssued": "string",
    "returnValueSettled": "string",
    "unpaidAmount": "string",
    "invoiceTotalPaisa": 0,
    "completedPaymentsPaisa": 0,
    "creditIssuedPaisa": 0,
    "returnValueSettledPaisa": 0,
    "unpaidAmountPaisa": 0
  }
  ```
- `customerCredit` (when balances loaded):
  ```json
  {
    "availableBalance": "string",
    "availableBalancePaisa": 0,
    "creditAppliedToInvoice": "string",
    "creditAppliedToInvoicePaisa": 0
  }
  ```
- `returnWorkflow`:
  ```json
  {
    "awaitingApproval": 0,
    "awaitingApprovalValue": "string",
    "awaitingSettlement": "string",
    "awaitingSettlementPaisa": 0,
    "nextStep": "approve_return" | "settle_return_credit" | null
  }
  ```
