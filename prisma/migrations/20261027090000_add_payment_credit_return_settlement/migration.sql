-- Payment, customer credit and return-settlement engine additions.
-- Current set of migration SQL. No additional statements were required.
-- Non-breaking: every change is an added nullable/defaulted column or a new
-- table; no existing column, constraint or row is modified.
--
--   Invoices.version                 - optimistic-concurrency token so two
--                                       concurrent "Record payment" saves
--                                       cannot silently overwrite each other.
--   InvoicePayments.idempotencyKey   - replay-safe save button (double submit).
--   CustomerCreditLedger.sourceInvoiceId
--                                    - invoice reference required on every
--                                       credit ledger entry (issued, applied,
--                                       return_credit, ...).
--   CustomerCreditLedger.idempotencyKey
--                                    - replay-safe when a save issues credit
--                                       without recording cash.
--   StockMovements                   - append-only stock ledger written when a
--                                       physical return is approved; stock is
--                                       incremented, never overwritten.

ALTER TABLE [dbo].[Invoices] ADD [version] INT NOT NULL CONSTRAINT [Invoices_version_df] DEFAULT 0;

ALTER TABLE [dbo].[InvoicePayments] ADD [idempotencyKey] NVARCHAR(120) NULL;

ALTER TABLE [dbo].[CustomerCreditLedger] ADD [sourceInvoiceId] INT NULL;
ALTER TABLE [dbo].[CustomerCreditLedger] ADD [idempotencyKey] NVARCHAR(120) NULL;

ALTER TABLE [dbo].[CustomerCreditLedger] ADD CONSTRAINT [CustomerCreditLedger_sourceInvoiceId_fkey]
    FOREIGN KEY ([sourceInvoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX [CustomerCreditLedger_sourceInvoiceId_idx] ON [dbo].[CustomerCreditLedger]([sourceInvoiceId]);

CREATE TABLE [dbo].[StockMovements] (
    [id] INT NOT NULL IDENTITY(1,1),
    [productId] INT NOT NULL,
    [returnId] INT NULL,
    [invoiceId] INT NULL,
    [movement] NVARCHAR(30) NOT NULL,
    [quantity] INT NOT NULL,
    [stockAfter] INT NOT NULL,
    [reason] NVARCHAR(500) NULL,
    [createdBy] INT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [StockMovements_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [StockMovements_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [StockMovements_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Products]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [StockMovements_returnId_fkey] FOREIGN KEY ([returnId]) REFERENCES [dbo].[InvoiceReturns]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [StockMovements_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX [StockMovements_productId_createdAt_idx] ON [dbo].[StockMovements]([productId], [createdAt]);
CREATE INDEX [StockMovements_returnId_idx] ON [dbo].[StockMovements]([returnId]);
CREATE INDEX [StockMovements_invoiceId_idx] ON [dbo].[StockMovements]([invoiceId]);