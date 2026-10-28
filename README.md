# Digital Invoice Backend

REST API for the Digital Invoicing System. It manages users, customers, products, invoices, payments, returns, customer credit, reports, and dashboard summaries on Microsoft SQL Server.

Built with Node.js, Express 5, Prisma 7, and the Prisma SQL Server adapter. It uses JWT authentication, bcrypt password hashing, role-based authorization, request validation, rate limiting, and a cross-document audit trail.

---

## Table of contents

- [Features](#features)
- [Technology stack](#technology-stack)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [SQL Server setup](#sql-server-setup)
- [Running the API](#running-the-api)
- [Available scripts](#available-scripts)
- [Roles and permissions](#roles-and-permissions)
- [Financial rules](#financial-rules)
- [API overview](#api-overview)
- [Request and response format](#request-and-response-format)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Production deployment](#production-deployment)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## Features

### Authentication and users
- Sign-up and sign-in with bcrypt password hashing.
- Signed JWT access tokens (configurable secret, lifetime, issuer, audience).
- Authenticated identity endpoint and per-IP auth rate limiting.
- Role-based access control. Role changes through a CLI script.

### Customers
- Create, list, read, update, delete. Tax number (NTN), registration status, phone, address.
- Search and pagination. Per-customer credit balance and ledger.

### Products
- Create, list, read, update, delete. Six-digit product codes.
- Price, tax rate, stock quantity, active/inactive status (without deleting history).
- Low-stock data exposed to the dashboard.

### Invoices
- Draft creation, editing, deletion, listing. Automatic invoice numbering.
- Issue workflow that records issuer and issue date and decrements stock.
- Server-calculated line subtotal, line tax, subtotal, tax total, and grand total.
- Per-line snapshots of product name, code, unit price, and tax rate.
- Payments with optional credit given (udhaar) in the same save.
- Derived status and multi-badge status list: `paid`, `partially_paid`, `issued`, `overdue`, `credit`, `return`, plus `draft`, `cancelled`, `void`.
- Cancel (draft or issued, no money) and void (no payments, no approved returns, no applied credit).
- Per-invoice `editable` flag and `allowedActions` list derived from the money state.
- Status timeline with running totals after each step.
- Search, status, customer, and date-range filters. Pagination with a maximum page size of 100.

### Payments and credit given
- Record cash paid and/or credit given on one invoice in one atomic save.
- Cash plus credit may not exceed the unpaid amount before the save.
- Credit given is part of the unpaid amount. It never changes the customer's advance balance.
- Idempotency keys make double-clicked saves safe. Optimistic version checks reject stale saves with `409`.

### Returns
- Create a pending return. It reserves the quantity immediately, so `returnable` drops at once.
- Approve, reject, or cancel. Approval settles the money in one transaction.
- Saleable items are restocked on approval; unsaleable items are recorded but not restocked.
- Every invoice line reports `returnedQuantity`, `pendingReturnQuantity`, and `returnable`.

### Customer credit (advance)
- Grant credit (advance, goodwill, or correction) with a mandatory reason.
- Leftover return value is recorded as `return_credit` advance.
- Apply advance to an invoice (API endpoint).
- Immutable ledger. Reverse an entry with a mandatory reason.

### Reports
- Period summary, daily and monthly sales, tax by rate, customer-wise and product-wise sales, invoice history, return and credit status, sales tax by rate, receivables, voided invoices, returns, customer credit, activity history.

### Dashboard
- Current-month billing and collection, all-time receivables, overdue totals, low-stock products, recent invoices, monthly chart data.

### Platform
- Express 5 with centralized error handling. Helmet, configurable CORS allowlist.
- JSON and URL-encoded bodies limited to 100 KB.
- Field-level validation errors. Prisma unique and foreign-key errors mapped to readable responses.
- Graceful shutdown on `SIGINT` and `SIGTERM`. Database check at startup. Clear port-in-use diagnostics.
- Cross-document audit log with actor snapshots.

---

## Technology stack

| Package | Version | Purpose |
| --- | --- | --- |
| `express` | 5.x | HTTP server and routing |
| `@prisma/client` | 7.x | Database client |
| `@prisma/adapter-mssql` | 7.x | SQL Server driver adapter |
| `prisma` | 7.x | Schema, migrations, client generation |
| `bcryptjs` | 3.x | Password hashing |
| `jsonwebtoken` | 9.x | Access tokens |
| `cors` | 2.x | CORS allowlist |
| `helmet` | 8.x | Security headers |
| `express-rate-limit` | 8.x | Auth rate limiting |
| `dotenv` | 18.x | Environment loading |
| `nodemon` | 3.x | Development auto-restart |

Native ES modules (`"type": "module"`).

---

## Requirements

- **Node.js 20.19 or later** and npm
- **Microsoft SQL Server** with SQL Server Authentication enabled
- A database for the application, for example `digital invoice`
- Network access from the API host to the SQL Server instance

---

## Installation

1. Clone the repository and open it:

   ```bash
   git clone <backend-repository-url>
   cd digital-invoice-backend
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create the environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Edit `.env`:

   ```dotenv
   DATABASE_URL="sqlserver://<db-user>:<db-password>@localhost:1433;database=digital%20invoice;encrypt=true;trustServerCertificate=true;"
   JWT_SECRET=<generated-secret>
   ```

   Never commit a real `.env` file or production credentials.

5. Generate the Prisma client:

   ```powershell
   npm run prisma:generate
   ```

6. Create or apply the database schema:

   ```powershell
   npm run prisma:migrate
   ```

   For an existing deployment with committed migrations, use `npm run prisma:deploy`.

7. Start the API:

   ```powershell
   npm run dev
   ```

8. Verify:

   ```text
   GET http://localhost:5000/api/health
   ```

   ```json
   {
     "success": true,
     "data": { "status": "ok", "environment": "development", "timestamp": "2026-10-27T00:00:00.000Z", "uptimeSeconds": 12 }
   }
   ```

---

## Environment variables

The server validates required values at startup and exits when they are missing.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Set to `production` in production. |
| `PORT` | No | `5000` | HTTP port. |
| `HOST` | No | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy. |
| `DATABASE_URL` | Yes | — | SQL Server connection string. |
| `JWT_SECRET` | Yes | — | Signs JWTs. At least 32 characters in production. |
| `JWT_EXPIRES_IN` | No | `1d` | Token lifetime, for example `15m`, `1h`, `7d`. |
| `JWT_ISSUER` | No | `digital-invoice-api` | JWT `iss` claim. |
| `JWT_AUDIENCE` | No | `digital-invoice-web` | JWT `aud` claim. |
| `BCRYPT_ROUNDS` | No | `12` | bcrypt cost factor. |
| `CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed browser origins. |
| `AUTH_RATE_LIMIT_MAX` | No | `100` dev, `20` prod | Auth requests per IP per 15 minutes. |

Generate a strong secret:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"
```

Changing `JWT_SECRET` invalidates every existing token.

---

## SQL Server setup

1. Install SQL Server and SQL Server Management Studio or Azure Data Studio.
2. Enable SQL Server and Windows Authentication mode (Mixed Mode).
3. Create the database:

   ```sql
   CREATE DATABASE [digital invoice];
   ```

4. Create a dedicated login with rights on that database. Do not use `sa` in production.
5. Build the connection string. Database name and credentials must be URL-encoded (a space becomes `%20`):

   ```dotenv
   DATABASE_URL="sqlserver://<app-user>:<app-password>@localhost:1433;database=digital%20invoice;encrypt=true;trustServerCertificate=true;"
   ```

6. Confirm TCP/IP is enabled and the port is reachable from the API host.

### Schema changes

1. Edit `prisma/schema.prisma`.
2. Run `npm run prisma:migrate` locally and name the migration.
3. Commit the schema and the migration folder.
4. Run `npm run prisma:deploy` in each environment, then `npm run prisma:generate`.

### Audit type constraint

`AuditLogs.documentType` has a SQL Server CHECK constraint (`AuditLogs_documentType_check`). Every audit write must use a value the constraint allows, or the surrounding transaction rolls back. Check the allowed values with:

```sql
SELECT cc.definition
FROM sys.check_constraints cc
WHERE cc.name = 'AuditLogs_documentType_check';
```

---

## Running the API

```powershell
npm run dev     # development, restarts on changes (nodemon)
npm start       # production, node src/server.js
```

Default address: `http://localhost:5000`.

### Port already in use

```powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen | Select-Object OwningProcess
Stop-Process -Id <pid>
```

Or start on another port: `$env:PORT=5001; npm start`

---

## Available scripts

| Script | Description |
| --- | --- |
| `npm start` | Start the API with Node. |
| `npm run dev` | Start the API with nodemon. |
| `npm run prisma:generate` | Generate the Prisma client. |
| `npm run prisma:migrate` | Create and apply a development migration. |
| `npm run prisma:deploy` | Apply committed migrations (deployed environments). |
| `npm run prisma:studio` | Open Prisma Studio. |
| `npm run seed:demo -- --email <address>` | Add sample tax-rate products to an existing account. |
| `npm run set-role -- --email <address> --role <role>` | Change a user's role. |
| `npm test` | Run all end-to-end suites sequentially against a live API. |

New accounts start as `sales`. Available roles: `sales`, `accounts`, `manager`, `admin`.

---

## Roles and permissions

Permissions are defined once in `src/utils/permissions.js`. Routes enforce them with `requirePermission()`, and financial services re-check the same permission.

The current configuration grants every permission to every role, which suits an internal team that enters its own data. Every financial action is still recorded in the audit log with the actor's name and email.

To restrict an action later, change its entry in `PERMISSIONS`, for example:

```javascript
'return.approve': ['manager', 'admin'],
'invoice.void': ['manager', 'admin'],
```

Customer and product endpoints require authentication but no specific role.

---

## Financial rules

### Money
- SQL Server `DECIMAL(18,2)` columns. Arithmetic in integer paisa. Single `ROUND_HALF_UP` policy at the persistence boundary. No floating-point money.

### Invoice amounts

```text
effective total = invoice total − approved return value
amount due      = effective total
unpaid          = amount due − cash paid − customer advance applied − legacy credit notes
```

Credit given (udhaar) is part of the unpaid amount. It is not added on top of the bill. It is shown separately as `creditOutstanding`.

Example: total 10,250, cash 8,000, credit given 200:
- Unpaid = 10,250 − 8,000 = **2,250**, of which 200 is credit given.
- The invoice becomes `paid` when cash received plus advance applied covers the unpaid amount.

### Payment save rule
- In one save, cash plus credit given may not exceed the unpaid amount before that save.
- Credit has no excess-cash requirement.
- Credit given does not change the customer's advance balance.

### Status and badges
- Stored status: `draft`, `issued`, `partially_paid`, `paid`, `cancelled`, `void`.
- `paid` when unpaid is 0. `partially_paid` when any money has been settled. Otherwise `issued`.
- `overdue` is derived from the due date and an open balance. It is never stored.
- Badges (an invoice can carry several):
  - `paid` when unpaid is 0.
  - `partially_paid` when some money is settled and a balance remains.
  - `issued` when nothing is settled and a balance remains (and not overdue).
  - `overdue` when a balance remains past the due date.
  - `credit` only while credit given or return credit still has an unpaid or unsettled part (unpaid > 0).
  - `return` while a return still holds quantity.

A fully paid invoice shows only `paid`, plus `return` if a return is still active.

### Returns
Two explicit steps:
1. **Create** — the quantity is reserved and `returnable` drops immediately. No money or stock moves.
2. **Approve** — in one transaction:
   - Saleable lines are restocked and a `StockMovement` is written per product.
   - The return value reduces the unpaid amount first.
   - Any leftover becomes `return_credit` customer advance.
   - The invoice status and version are refreshed.

Approved returns cannot be edited. Correct them with a new document.

### Customer advance (credit ledger)
- Ledger rows are immutable. Corrections are reversal rows with `reversesEntryId`.
- Advance balance is the signed sum of advance rows:
  - `credit_added` (+), `return_credit` (+), `credit_applied` (−), `cashout` (−), and their reversals.
- Credit given on an invoice (`issued` rows) is an invoice receivable and is excluded from the advance balance.
- Advance is spent first-in, first-out. Each spend writes a `CreditApplication` linking the source entry to the invoice.

### Cancel and void
- **Cancel:** draft or issued invoices with no money attached. Restores stock for issued invoices. Excluded from sales.
- **Void:** requires a reason, void date, and exact invoice number. Blocked when the invoice has completed payments, approved returns, or applied credit. Excluded from sales. Never deleted.
- **Delete:** draft or cancelled invoices only.

---

## API overview

All routes are under `/api`. Except `/api/health`, `/api/auth/signup`, and `/api/auth/signin`, every route requires `Authorization: Bearer <token>`.

### Health and authentication

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check (no database query). |
| `POST` | `/api/auth/signup` | Create an account. |
| `POST` | `/api/auth/signin` | Sign in and receive a JWT. |
| `GET` | `/api/auth/me` | Return the authenticated user. |

### Customers

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/customers` | Create. |
| `GET` | `/api/customers` | List (`page`, `limit`, `search`). |
| `GET` | `/api/customers/:id` | Read. |
| `PUT` | `/api/customers/:id` | Update. |
| `DELETE` | `/api/customers/:id` | Delete. |

### Products

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/products` | Create. |
| `GET` | `/api/products` | List (`page`, `limit`, `search`). |
| `GET` | `/api/products/:id` | Read. |
| `PUT` | `/api/products/:id` | Update. |
| `PATCH` | `/api/products/:id/status` | Activate or deactivate. |
| `DELETE` | `/api/products/:id` | Delete. |

### Invoices

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/invoices` | Create a draft. |
| `GET` | `/api/invoices` | List (`page`, `limit`, `search`, `status`, `customerId`, `from`, `to`). |
| `GET` | `/api/invoices/:id` | Read. |
| `GET` | `/api/invoices/:id/timeline` | Status history (`history`, `events`, `legacyActivities`). |
| `PUT` | `/api/invoices/:id` | Update while not fully paid. |
| `PATCH` | `/api/invoices/:id/issue` | Issue a draft. |
| `PATCH` | `/api/invoices/:id/pay` | Settle the remaining unpaid amount in one payment. |
| `POST` | `/api/invoices/:id/payments` | Record cash and/or credit given. |
| `PATCH` | `/api/invoices/:id/payments/:paymentId` | Correct a completed payment. |
| `PATCH` | `/api/invoices/:id/cancel` | Cancel a draft or issued invoice. |
| `PATCH` | `/api/invoices/:id/void` | Void an invoice. |
| `DELETE` | `/api/invoices/:id` | Delete a draft or cancelled invoice. |

Payment body:

```json
{
  "amount": "8000.00",
  "creditAmount": "200.00",
  "creditReason": "need money",
  "paymentDate": "2026-10-28",
  "expectedVersion": 3,
  "idempotencyKey": "b7f2c9e0-1a2b-4c3d-8e9f-0123456789ab",
  "method": "cash",
  "reference": "optional",
  "notes": "optional"
}
```

`amount` and `creditAmount` are optional, but at least one must be greater than zero. `creditReason` is required when `creditAmount` is set. Response: `201` on a new save, `200` with `replayed: true` on a repeated idempotency key.

Void body:

```json
{ "reason": "Duplicate invoice", "voidDate": "2026-10-28", "confirmNumber": "INV-1001" }
```

### Returns

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/invoices/:id/returns` | Create a pending return. |
| `GET` | `/api/invoices/:id/returns/:returnId` | Read a return. |
| `PATCH` | `/api/invoices/:id/returns/:returnId` | Edit a pending or draft return. |
| `PATCH` | `/api/invoices/:id/returns/:returnId/approve` | Approve and settle. |
| `PATCH` | `/api/invoices/:id/returns/:returnId/reject` | Reject (reason required). |
| `PATCH` | `/api/invoices/:id/returns/:returnId/cancel` | Cancel a pending return. |
| `GET` | `/api/returns` | List returns. |
| `GET` | `/api/returns/:returnId` | Read a return. |
| `PATCH` | `/api/returns/:returnId/approve` | Approve (same logic as above). |
| `PATCH` | `/api/returns/:returnId/reject` | Reject. |
| `PATCH` | `/api/returns/:returnId/cancel` | Cancel. |

Create return body:

```json
{
  "returnDate": "2026-10-28",
  "reason": "Damaged on delivery",
  "items": [{ "invoiceItemId": 12, "quantity": 1, "disposition": "saleable" }]
}
```

`disposition` is `saleable` or `unsaleable`.

### Customer credit and documents

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/documents` | Cross-document register. |
| `GET` | `/api/customers/:customerId/credit` | Advance balance and ledger. |
| `POST` | `/api/customers/:customerId/credit` | Grant advance (`amount`, `reason`, optional `reference`). |
| `POST` | `/api/customers/:customerId/credit/applications` | Apply advance to an invoice (`invoiceId`, `amount`). |
| `POST` | `/api/credit-entries/:entryId/reverse` | Reverse an entry (`reason`). |

### Reports

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/reports/summary` | Period summary. |
| `GET` | `/api/reports/daily-sales` | Daily sales. |
| `GET` | `/api/reports/monthly-sales` | Monthly sales. |
| `GET` | `/api/reports/tax` | Tax by rate. |
| `GET` | `/api/reports/customers` | Customer-wise report. |
| `GET` | `/api/reports/products` | Product-wise report. |
| `GET` | `/api/reports/invoice-history` | Invoice history. |
| `GET` | `/api/reports/return-credit-status` | Returns and credit status. |
| `GET` | `/api/reports/sales-tax-by-rate` | Sales tax by rate. |
| `GET` | `/api/reports/receivables` | Outstanding receivables. |
| `GET` | `/api/reports/voided-invoices` | Voided invoices. |
| `GET` | `/api/reports/returns` | Returns report. |
| `GET` | `/api/reports/customer-credit` | Customer credit report. |
| `GET` | `/api/reports/activity` | Activity history. |

Common filters: `from`, `to`, `page`, `limit` (max 100). Some add `status`, `customerId`, `invoiceNumber`.

### Dashboard

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/dashboard/summary` | Current-month summary, receivables, overdue, low stock, recent invoices, chart data. No query parameters. |

---

## Request and response format

Success:

```json
{ "success": true, "data": {} }
```

Error:

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [{ "field": "email", "message": "Enter a valid email address" }]
}
```

| Code | Meaning |
| --- | --- |
| `200` | Success. |
| `201` | Created. |
| `400` | Validation failure. |
| `401` | Missing, invalid, or expired token. |
| `403` | Not permitted. |
| `404` | Not found. |
| `409` | Business-rule conflict, stale version, or duplicate action. |
| `413` | Body too large. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected error (no internals exposed in production). |

---

## Project structure

```text
prisma/
  schema.prisma               # Data model and financial invariants
  migrations/                 # SQL Server migrations
scripts/
  seed-demo-tax-rates.mjs     # Development sample products
  set-role.mjs                # Role assignment CLI
src/
  app.js                      # Express app, Helmet, CORS, JSON limits, routes
  server.js                   # Startup, port handling, DB check, shutdown
  config/                     # Validated environment configuration
  controllers/                # HTTP handlers
  db/                         # Prisma client and adapter
  middleware/                 # Authentication, roles, validation, errors
  routes/                     # Route definitions and permission wiring
  services/
    invoice.service.js        # Invoice lifecycle, payments, cancel, void, timeline
    financial.service.js      # Returns and the document register
    credit.service.js         # Customer advance: grant, apply, reverse
    settlement.policy.js      # Business rules: unpaid, return waterfall, badges
    settlement.service.js     # The single money calculation used everywhere
    audit.service.js          # Audit writer and snapshot parser
  utils/                      # ApiError, JWT, money, permissions
  validators/                 # Request and query validation
test/
  auth.e2e.mjs  customer.e2e.mjs  product.e2e.mjs
  invoice.e2e.mjs  report.e2e.mjs  dashboard.e2e.mjs
```

---

## Testing

The suites are end-to-end scripts that call a running API and use the configured database. Use a dedicated development or test database. They create accounts and records.

```powershell
npm test                      # all suites, sequential
node test/invoice.e2e.mjs     # one suite
```

Prerequisites: SQL Server running, `.env` configured, migrations applied, and the API running at `http://localhost:5000` (or set `API_BASE_URL`).

---

## Production deployment

### 1. Environment

```dotenv
NODE_ENV=production
PORT=5000
HOST=127.0.0.1
DATABASE_URL="sqlserver://<app-user>:<app-password>@db.internal:1433;database=digital%20invoice;encrypt=true;trustServerCertificate=false;"
JWT_SECRET=<64-byte-random-value>
JWT_EXPIRES_IN=1d
CORS_ORIGINS=https://invoices.example.com
AUTH_RATE_LIMIT_MAX=20
```

### 2. Install and migrate

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
```

Do not run `prisma migrate dev` in production.

### 3. Run under a process manager

PM2:

```bash
pm2 start src/server.js --name digital-invoice-api
pm2 save
pm2 startup
```

systemd:

```ini
[Unit]
Description=Digital Invoice API
After=network.target

[Service]
Type=simple
User=invoice
WorkingDirectory=/opt/digital-invoice-backend
EnvironmentFile=/opt/digital-invoice-backend/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

### 4. Reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/ssl/certs/api.example.com.crt;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

### 5. Verify

```bash
curl -i https://api.example.com/api/health
npx prisma migrate status
```

Then sign in, create a test invoice, record a payment, approve a return, and open a report.

### Checklist
- [ ] `NODE_ENV=production`, strong `JWT_SECRET`, exact `CORS_ORIGINS`
- [ ] `prisma migrate deploy` completed and client generated
- [ ] TLS and reverse proxy configured; API bound to `127.0.0.1`
- [ ] Database port not exposed publicly; least-privilege login
- [ ] Backups scheduled and restore-tested
- [ ] Health check monitored; process restarts on failure

Keep at least one previous release for rollback. A schema rollback may require a database restore, so test migrations on a copy of production data first.

---

## Security

- Helmet headers; CORS limited to configured origins; bodies limited to 100 KB.
- bcrypt password hashing; JWT with configurable secret, issuer, audience, and lifetime.
- Auth endpoints rate-limited per IP.
- Permissions enforced in routes and re-checked in financial services.
- Production `500` responses are generic. Server logs record method and URL, never bodies or tokens.
- Audit records keep actor snapshots for financial mutations.

Recommendations: serve everything over HTTPS, keep `.env` out of version control, disable `sa` for the application, back up before migrations, rotate `JWT_SECRET` after a suspected compromise, and review audit logs and roles periodically.

---

## Troubleshooting

**"Missing required environment variable"**
`DATABASE_URL` or `JWT_SECRET` is missing. Copy `.env.example` to `.env` and fill in the values.

**`JWT_SECRET must be at least 32 characters long in production`**
Generate a longer secret (see [Environment variables](#environment-variables)).

**Database connection failed at startup**
Check that SQL Server is running, TCP/IP is enabled, the host, port, user, and password are correct, the database name is URL-encoded, and the login has access.

**`Port 5000 is already in use`**
Stop the process using the port, or start with `$env:PORT=5001; npm start`.

**Prisma client out of date**
Run `npm run prisma:generate` and restart the API after changing `schema.prisma` or pulling migrations.

**`ReferenceError` or `P2003`/CHECK constraint errors on payments or returns**
A write is using a value the database rejects, such as an audit `documentType` outside the allowed list, or a foreign key that points to a missing row. Read the Prisma error code and `meta` in the server log, then correct the value. Do not drop constraints.

**Browser requests fail with CORS**
Add the exact frontend origin, with scheme and port and no trailing slash, to `CORS_ORIGINS`, then restart.

**`401 Unauthorized`**
Sign in again. Check that `JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE` have not changed.

**`403 Forbidden`**
The role lacks the permission. Check the permissions map or promote the account with `npm run set-role`.

**Financial totals look wrong**
Confirm clients show backend values rather than recalculating. Check whether the invoice is draft or void (both excluded from sales), confirm the payment went to the intended invoice, and inspect the timeline. Do not update money columns directly in SQL; use the API so balances and audit entries stay consistent.