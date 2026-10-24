BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Invoices] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [invoiceNumber] NVARCHAR(30) NOT NULL,
    [customerId] INT NOT NULL,
    [invoiceDate] DATE NOT NULL,
    [dueDate] DATE,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [Invoices_status_df] DEFAULT 'draft',
    [subtotal] DECIMAL(18,2) NOT NULL CONSTRAINT [Invoices_subtotal_df] DEFAULT 0,
    [taxTotal] DECIMAL(18,2) NOT NULL CONSTRAINT [Invoices_taxTotal_df] DEFAULT 0,
    [grandTotal] DECIMAL(18,2) NOT NULL CONSTRAINT [Invoices_grandTotal_df] DEFAULT 0,
    [notes] NVARCHAR(2000),
    [paidAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Invoices_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Invoices_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Invoices_invoiceNumber_key] UNIQUE NONCLUSTERED ([invoiceNumber])
);

-- CreateTable
CREATE TABLE [dbo].[InvoiceItems] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [productId] INT,
    [productName] NVARCHAR(200) NOT NULL,
    [productCode] NVARCHAR(50),
    [quantity] INT NOT NULL,
    [unitPrice] DECIMAL(18,2) NOT NULL,
    [taxRate] DECIMAL(5,2) NOT NULL,
    [lineSubtotal] DECIMAL(18,2) NOT NULL,
    [lineTax] DECIMAL(18,2) NOT NULL,
    [lineTotal] DECIMAL(18,2) NOT NULL,
    CONSTRAINT [InvoiceItems_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[InvoiceCounters] (
    [id] INT NOT NULL,
    [nextValue] INT NOT NULL,
    CONSTRAINT [InvoiceCounters_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Invoices_userId_createdAt_idx] ON [dbo].[Invoices]([userId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Invoices_userId_status_idx] ON [dbo].[Invoices]([userId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Invoices_userId_customerId_idx] ON [dbo].[Invoices]([userId], [customerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Invoices_userId_invoiceDate_idx] ON [dbo].[Invoices]([userId], [invoiceDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InvoiceItems_invoiceId_idx] ON [dbo].[InvoiceItems]([invoiceId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [InvoiceItems_productId_idx] ON [dbo].[InvoiceItems]([productId]);

-- AddForeignKey
ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_customerId_fkey] FOREIGN KEY ([customerId]) REFERENCES [dbo].[Customers]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InvoiceItems] ADD CONSTRAINT [InvoiceItems_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InvoiceItems] ADD CONSTRAINT [InvoiceItems_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Products]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Seed the single numbering row. The service increments it atomically inside
-- the same transaction that inserts the invoice, so numbers are unique and
-- gap-free (a rollback also rolls the counter back).
INSERT INTO [dbo].[InvoiceCounters] ([id], [nextValue]) VALUES (1, 1001);

-- Defence in depth: the application validates these rules, and the database
-- enforces them as well. SQL Server column types cannot express them.
ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_status_check]
    CHECK ([status] IN ('draft', 'issued', 'paid', 'cancelled'));

ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_amounts_check]
    CHECK ([subtotal] >= 0 AND [taxTotal] >= 0 AND [grandTotal] >= 0);

ALTER TABLE [dbo].[InvoiceItems] ADD CONSTRAINT [InvoiceItems_quantity_check]
    CHECK ([quantity] > 0);

ALTER TABLE [dbo].[InvoiceItems] ADD CONSTRAINT [InvoiceItems_amounts_check]
    CHECK ([unitPrice] >= 0 AND [taxRate] >= 0 AND [taxRate] <= 100
           AND [lineSubtotal] >= 0 AND [lineTax] >= 0 AND [lineTotal] >= 0);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
