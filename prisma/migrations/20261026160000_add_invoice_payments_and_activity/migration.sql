CREATE TABLE [InvoicePayments] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [paymentDate] DATE NOT NULL,
    [amount] DECIMAL(18,2) NOT NULL,
    [method] NVARCHAR(30) NOT NULL,
    [reference] NVARCHAR(100) NULL,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [InvoicePayments_status_df] DEFAULT 'completed',
    [notes] NVARCHAR(1000) NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InvoicePayments_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [InvoicePayments_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InvoicePayments_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX [InvoicePayments_invoiceId_paymentDate_idx] ON [InvoicePayments]([invoiceId], [paymentDate]);
CREATE INDEX [InvoicePayments_invoiceId_status_idx] ON [InvoicePayments]([invoiceId], [status]);

CREATE TABLE [InvoiceActivities] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [actorId] INT NOT NULL,
    [eventType] NVARCHAR(50) NOT NULL,
    [description] NVARCHAR(500) NOT NULL,
    [amount] DECIMAL(18,2) NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InvoiceActivities_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [InvoiceActivities_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InvoiceActivities_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [Invoices]([id]) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT [InvoiceActivities_actorId_fkey] FOREIGN KEY ([actorId]) REFERENCES [Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX [InvoiceActivities_invoiceId_createdAt_idx] ON [InvoiceActivities]([invoiceId], [createdAt]);

INSERT INTO [InvoicePayments] ([invoiceId], [paymentDate], [amount], [method], [status], [notes], [createdAt])
SELECT [id], CAST(COALESCE([paidAt], [updatedAt]) AS DATE), [grandTotal], 'legacy', 'completed',
       'Migrated from an invoice previously marked as paid', COALESCE([paidAt], [updatedAt])
FROM [Invoices]
WHERE [status] = 'paid' AND [grandTotal] > 0;
