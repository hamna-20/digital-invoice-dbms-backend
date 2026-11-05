-- Additive-only migration for Third Schedule retail prices.
--
-- No existing table, column, constraint or row is modified or removed.
-- Existing products and invoice lines keep NULL until the user captures a
-- fixed/notified retail price.

BEGIN TRY

BEGIN TRAN;

IF COL_LENGTH('dbo.Products', 'retailPrice') IS NULL
    ALTER TABLE [dbo].[Products] ADD [retailPrice] DECIMAL(18,2) NULL;

IF COL_LENGTH('dbo.InvoiceItems', 'retailPrice') IS NULL
    ALTER TABLE [dbo].[InvoiceItems] ADD [retailPrice] DECIMAL(18,2) NULL;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;

THROW

END CATCH
