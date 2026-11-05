-- Additive-only migration for Customer and Product extensions.
-- All added columns are nullable with sensible defaults; existing rows
-- are preserved and no existing column, constraint or row is modified.

BEGIN TRY

BEGIN TRAN;

-- AlterTable: add customer classification and bank details
ALTER TABLE [dbo].[Customers] ADD [customerType] NVARCHAR(30) NULL,
[filerStatus] NVARCHAR(30) NULL,
[taxExemptionDetails] NVARCHAR(500) NULL,
[bankName] NVARCHAR(100) NULL,
[bankBranch] NVARCHAR(100) NULL,
[accountTitle] NVARCHAR(200) NULL,
[accountNumber] NVARCHAR(60) NULL;

-- AlterTable: add packing, weight to Products
ALTER TABLE [dbo].[Products] ADD [packing] NVARCHAR(100) NULL,
[weight] DECIMAL(18,2) NOT NULL CONSTRAINT [Products_weight_df] DEFAULT 0;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;

THROW

END CATCH
