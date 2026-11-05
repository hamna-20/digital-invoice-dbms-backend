-- Additive-only migration: local FBR HS-code reference table and the
-- optional seller province stored on the account.
--
-- No existing table, column, constraint or row is modified or removed.

BEGIN TRY

BEGIN TRAN;

-- AlterTable: optional seller province for FBR mock readiness
ALTER TABLE [dbo].[Users] ADD [businessProvince] NVARCHAR(100) NULL;

-- CreateTable: local reference data only; never synced to FBR from this app.
CREATE TABLE [dbo].[FbrHsCodes] (
    [hsCode] NVARCHAR(20) NOT NULL,
    [description] NVARCHAR(max) NOT NULL,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [FbrHsCodes_pkey] PRIMARY KEY CLUSTERED ([hsCode])
);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;

THROW

END CATCH
