-- Additive-only migration for the internal FBR/PRAL-style mock workflow.
--
-- Existing tables only gain nullable columns or NOT NULL columns with a
-- DEFAULT 0, which SQL Server back-fills for existing rows. Two new tables are
-- created: BusinessProfiles (one seller profile per user) and
-- MockFbrSubmissions (one internal mock record per invoice). Nothing is
-- dropped, truncated or reset.

BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Customers] ADD [province] NVARCHAR(50),
[strn] NVARCHAR(50);

-- AlterTable
ALTER TABLE [dbo].[InvoiceItems] ADD [advanceTax] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_advanceTax_df] DEFAULT 0,
[discount] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_discount_df] DEFAULT 0,
[extraTax] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_extraTax_df] DEFAULT 0,
[fedPayable] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_fedPayable_df] DEFAULT 0,
[furtherTax] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_furtherTax_df] DEFAULT 0,
[hsCode] NVARCHAR(20),
[saleType] NVARCHAR(30),
[salesTaxWithheldAtSource] DECIMAL(18,2) NOT NULL CONSTRAINT [InvoiceItems_salesTaxWithheldAtSource_df] DEFAULT 0,
[sroItemSerialNo] NVARCHAR(30),
[sroScheduleNo] NVARCHAR(50),
[uom] NVARCHAR(30);

-- AlterTable
ALTER TABLE [dbo].[Invoices] ADD [fbrSnapshotJson] NVARCHAR(max);

-- AlterTable
ALTER TABLE [dbo].[Products] ADD [advanceTaxRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_advanceTaxRate_df] DEFAULT 0,
[extraTaxRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_extraTaxRate_df] DEFAULT 0,
[fedRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_fedRate_df] DEFAULT 0,
[furtherTaxRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_furtherTaxRate_df] DEFAULT 0,
[hsCode] NVARCHAR(20),
[saleType] NVARCHAR(30),
[salesTaxWithheldRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_salesTaxWithheldRate_df] DEFAULT 0,
[sroItemSerialNo] NVARCHAR(30),
[sroScheduleNo] NVARCHAR(50);

-- CreateTable
CREATE TABLE [dbo].[BusinessProfiles] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [businessName] NVARCHAR(200),
    [ntn] NVARCHAR(50),
    [strn] NVARCHAR(50),
    [province] NVARCHAR(50),
    [address] NVARCHAR(500),
    [email] NVARCHAR(320),
    [phone] NVARCHAR(50),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [BusinessProfiles_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [BusinessProfiles_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [BusinessProfiles_userId_key] UNIQUE NONCLUSTERED ([userId])
);

-- CreateTable
CREATE TABLE [dbo].[MockFbrSubmissions] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [reference] NVARCHAR(60) NOT NULL,
    [status] NVARCHAR(30) NOT NULL,
    [payloadJson] NVARCHAR(max),
    [validationJson] NVARCHAR(max),
    [validatedAt] DATETIME2,
    [submittedAt] DATETIME2,
    [createdBy] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [MockFbrSubmissions_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [MockFbrSubmissions_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [MockFbrSubmissions_invoiceId_key] UNIQUE NONCLUSTERED ([invoiceId]),
    CONSTRAINT [MockFbrSubmissions_reference_key] UNIQUE NONCLUSTERED ([reference])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [MockFbrSubmissions_status_idx] ON [dbo].[MockFbrSubmissions]([status]);

-- AddForeignKey
ALTER TABLE [dbo].[BusinessProfiles] ADD CONSTRAINT [BusinessProfiles_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MockFbrSubmissions] ADD CONSTRAINT [MockFbrSubmissions_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[MockFbrSubmissions] ADD CONSTRAINT [MockFbrSubmissions_createdBy_fkey] FOREIGN KEY ([createdBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
