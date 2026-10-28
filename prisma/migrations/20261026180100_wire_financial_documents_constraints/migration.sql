-- Part 2 of 2 for 20261026180000_add_financial_documents_and_audit.
--
-- Part 1 added the columns and tables; this file does everything that
-- *references* those new columns. SQL Server binds indexes, foreign keys and
-- CHECK constraints when the batch is compiled, so they cannot see a column
-- created by ALTER TABLE earlier in the same batch ("Invalid column name").
-- Prisma applies each migration as its own batch, which is why this is a
-- separate migration file rather than a second section of the first one.
--
-- Nothing here drops or rewrites existing business data.

BEGIN TRY

BEGIN TRAN;

/* ------------------------------------------------------------------ */
/* 1. Tighten the nullable columns added in part 1                     */
/* ------------------------------------------------------------------ */

-- Back-fill from the original invoice so the denormalised columns are always
-- consistent with the immutable invoice they reference.
UPDATE [r]
SET [r].[customerId] = [i].[customerId],
    [r].[createdBy]  = [i].[userId]
FROM [dbo].[InvoiceReturns] AS [r]
INNER JOIN [dbo].[Invoices] AS [i] ON [i].[id] = [r].[invoiceId];

ALTER TABLE [dbo].[InvoiceReturns] ALTER COLUMN [customerId] INT NOT NULL;
ALTER TABLE [dbo].[InvoiceReturns] ALTER COLUMN [createdBy] INT NOT NULL;

-- Part 1 needed these DEFAULTs only so that NOT NULL columns could be added
-- to tables that already contain rows. The Prisma client always writes
-- updatedAt itself (@updatedAt), so the defaults are removed again to keep
-- the physical schema identical to the datamodel.
ALTER TABLE [dbo].[InvoicePayments] DROP CONSTRAINT [InvoicePayments_updatedAt_df];
ALTER TABLE [dbo].[InvoiceReturns] DROP CONSTRAINT [InvoiceReturns_updatedAt_df];

/* ------------------------------------------------------------------ */
/* 2. Indexes over the new columns                                     */
/* ------------------------------------------------------------------ */

CREATE NONCLUSTERED INDEX [Users_role_idx] ON [dbo].[Users]([role]);
CREATE NONCLUSTERED INDEX [InvoiceReturns_customerId_idx] ON [dbo].[InvoiceReturns]([customerId]);

/* ------------------------------------------------------------------ */
/* 3. Role guard                                                       */
/* ------------------------------------------------------------------ */

ALTER TABLE [dbo].[Users] ADD CONSTRAINT [Users_role_check]
    CHECK ([role] IN ('sales', 'accounts', 'manager', 'admin'));

/* ------------------------------------------------------------------ */
/* 4. Foreign keys                                                     */
/* ------------------------------------------------------------------ */

ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_issuedBy_fkey]
    FOREIGN KEY ([issuedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_voidedBy_fkey]
    FOREIGN KEY ([voidedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE [dbo].[InvoicePayments] ADD CONSTRAINT [InvoicePayments_createdBy_fkey]
    FOREIGN KEY ([createdBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_customerId_fkey]
    FOREIGN KEY ([customerId]) REFERENCES [dbo].[Customers]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_createdBy_fkey]
    FOREIGN KEY ([createdBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_approvedBy_fkey]
    FOREIGN KEY ([approvedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Return items now resolve back to the invoiced line they reverse.
ALTER TABLE [dbo].[InvoiceReturnItems] ADD CONSTRAINT [InvoiceReturnItems_invoiceItemId_fkey]
    FOREIGN KEY ([invoiceItemId]) REFERENCES [dbo].[InvoiceItems]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
