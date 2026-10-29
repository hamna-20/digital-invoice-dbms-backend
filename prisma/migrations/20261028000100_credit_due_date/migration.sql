BEGIN TRY

BEGIN TRAN;

-- Add creditDueDate to CustomerCreditLedger
ALTER TABLE [dbo].[CustomerCreditLedger] ADD [creditDueDate] DATE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;

THROW;

END CATCH
