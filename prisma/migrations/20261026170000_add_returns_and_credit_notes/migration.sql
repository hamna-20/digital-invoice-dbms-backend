CREATE TABLE [InvoiceReturns] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [returnNumber] NVARCHAR(40) NOT NULL,
    [returnDate] DATE NOT NULL,
    [reason] NVARCHAR(500) NOT NULL,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [InvoiceReturns_status_df] DEFAULT 'pending',
    [subtotal] DECIMAL(18,2) NOT NULL,
    [taxTotal] DECIMAL(18,2) NOT NULL,
    [totalAmount] DECIMAL(18,2) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [InvoiceReturns_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [InvoiceReturns_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InvoiceReturns_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [InvoiceReturns_status_check] CHECK ([status] IN ('pending', 'approved', 'rejected')),
    CONSTRAINT [InvoiceReturns_amounts_check] CHECK ([subtotal] >= 0 AND [taxTotal] >= 0 AND [totalAmount] >= 0)
);
CREATE UNIQUE INDEX [InvoiceReturns_returnNumber_key] ON [InvoiceReturns]([returnNumber]);
CREATE INDEX [InvoiceReturns_invoiceId_returnDate_idx] ON [InvoiceReturns]([invoiceId], [returnDate]);
CREATE INDEX [InvoiceReturns_invoiceId_status_idx] ON [InvoiceReturns]([invoiceId], [status]);

CREATE TABLE [InvoiceReturnItems] (
    [id] INT NOT NULL IDENTITY(1,1),
    [returnId] INT NOT NULL,
    [invoiceItemId] INT NOT NULL,
    [productId] INT NULL,
    [productName] NVARCHAR(200) NOT NULL,
    [quantity] INT NOT NULL,
    [disposition] NVARCHAR(20) NOT NULL,
    [unitPrice] DECIMAL(18,2) NOT NULL,
    [taxRate] DECIMAL(5,2) NOT NULL,
    [subtotal] DECIMAL(18,2) NOT NULL,
    [taxAmount] DECIMAL(18,2) NOT NULL,
    [totalAmount] DECIMAL(18,2) NOT NULL,
    CONSTRAINT [InvoiceReturnItems_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InvoiceReturnItems_returnId_fkey] FOREIGN KEY ([returnId]) REFERENCES [InvoiceReturns]([id]) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT [InvoiceReturnItems_quantity_check] CHECK ([quantity] > 0),
    CONSTRAINT [InvoiceReturnItems_disposition_check] CHECK ([disposition] IN ('saleable', 'unsaleable'))
);
CREATE INDEX [InvoiceReturnItems_returnId_idx] ON [InvoiceReturnItems]([returnId]);
CREATE INDEX [InvoiceReturnItems_invoiceItemId_idx] ON [InvoiceReturnItems]([invoiceItemId]);

CREATE TABLE [CreditNotes] (
    [id] INT NOT NULL IDENTITY(1,1),
    [invoiceId] INT NOT NULL,
    [returnId] INT NULL,
    [creditNumber] NVARCHAR(40) NOT NULL,
    [issueDate] DATE NOT NULL,
    [reason] NVARCHAR(500) NOT NULL,
    [subtotal] DECIMAL(18,2) NOT NULL,
    [taxTotal] DECIMAL(18,2) NOT NULL,
    [totalAmount] DECIMAL(18,2) NOT NULL,
    [appliedAmount] DECIMAL(18,2) NOT NULL CONSTRAINT [CreditNotes_appliedAmount_df] DEFAULT 0,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [CreditNotes_status_df] DEFAULT 'issued',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CreditNotes_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CreditNotes_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CreditNotes_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditNotes_returnId_fkey] FOREIGN KEY ([returnId]) REFERENCES [InvoiceReturns]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditNotes_status_check] CHECK ([status] IN ('issued', 'void')),
    CONSTRAINT [CreditNotes_amounts_check] CHECK ([subtotal] >= 0 AND [taxTotal] >= 0 AND [totalAmount] > 0 AND [appliedAmount] >= 0 AND [appliedAmount] <= [totalAmount])
);
CREATE UNIQUE INDEX [CreditNotes_returnId_key] ON [CreditNotes]([returnId]) WHERE [returnId] IS NOT NULL;
CREATE UNIQUE INDEX [CreditNotes_creditNumber_key] ON [CreditNotes]([creditNumber]);
CREATE INDEX [CreditNotes_invoiceId_issueDate_idx] ON [CreditNotes]([invoiceId], [issueDate]);
