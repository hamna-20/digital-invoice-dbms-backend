-- Additive-only migration for the FBR buyer classification.
-- Existing customer rows are preserved; legacy rows keep NULL and the API
-- infers a buyer type from their registration value.

BEGIN TRY

BEGIN TRAN;

ALTER TABLE [dbo].[Customers] ADD [buyerType] INT NULL;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;

THROW

END CATCH
