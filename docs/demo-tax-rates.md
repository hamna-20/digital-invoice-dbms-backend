# Demo tax rates (development only)

The backend supports a configurable `Product.taxRate` from **0 to 100** with two
decimal places. Invoice totals are always calculated on the server from the
product's stored price and tax rate; the frontend only previews them.

## Sample values

`npm run seed:demo` can create four clearly labelled demo products:

| Code          | Sample rate | Purpose                        |
| ------------- | ----------- | ------------------------------ |
| `DEMO-TAX-0`  | 0%          | zero-rated / exempt preview    |
| `DEMO-TAX-5`  | 5%          | reduced-rate preview           |
| `DEMO-TAX-17` | 17%         | standard-rate preview (sample) |
| `DEMO-TAX-18` | 18%         | standard-rate preview (sample) |

> **These are sample development values, not official FBR rates.**
> Do not present them as legal or current tax rates. Replace them with the
> confirmed rates for your business before real use.

## Run it

The script needs an existing account (sign up in the app first). It only adds
products that are missing for that user.

```powershell
npm run seed:demo -- --email you@example.test
```

or:

```powershell
$env:DEMO_SEED_EMAIL="you@example.test"; npm run seed:demo
```

## Safety rules

- Existing products are **never updated**. If `DEMO-TAX-*` already exists, the
  script skips it, so user-configured prices and rates are preserved.
- No production-like data is touched; the script is scoped to one user.
- Issued invoices keep the `taxRate` and `unitPrice` snapshots stored in
  `InvoiceItems`, so later product/rate changes do not rewrite history.
- Draft invoices re-read the current product price and tax rate when edited,
  because a draft is not historical yet.

## Verification

`test/invoice.e2e.mjs` checks 0%, 10%, 17.5% and 18% rates, half-up rounding,
stock transactions, and that changing a product's price **and tax rate** does
not alter an issued invoice. `test/report.e2e.mjs` checks that the tax report
uses the saved line snapshots, not current product rates.
