-- Adds roles, invoice void/issue tracking, return authorship, the return
-- credit ledger, refunds, customer credit ledger, credit applications, the
-- audit log and document counters.
--
-- Part 1 of 2: purely additive DDL plus data back-fills. It deliberately
-- contains NO index, FK or CHECK that references a column added in this same
-- batch - SQL Server refuses to bind those ("Invalid column name"), so all
-- such wiring lives in 20261026180100_wire_financial_documents_constraints.
--
-- Safe for an existing database: every NOT NULL column added to a table that
-- already contains rows is added nullable first and tightened in part 2.
-- Nothing is dropped, truncated or reset.

BEGIN TRY

BEGIN TRAN;

/* ------------------------------------------------------------------ */
/* 1. Roles                                                            */
/* ------------------------------------------------------------------ */

-- The DEFAULT back-fills every existing row with 'sales' (least privilege).
-- Promote accounts with scripts/set-role.mjs.
ALTER TABLE [dbo].[Users] ADD [role] NVARCHAR(20) NOT NULL CONSTRAINT [Users_role_df] DEFAULT 'sales';

/* ------------------------------------------------------------------ */
/* 2. Invoice issue + void columns, and cancelled -> void             */
/* ------------------------------------------------------------------ */

ALTER TABLE [dbo].[Invoices] ADD
    [issuedAt]   DATETIME2,
    [issuedBy]   INT,
    [voidedAt]   DATETIME2,
    [voidReason] NVARCHAR(500),
    [voidedBy]   INT;

-- The lifecycle status is renamed: 'cancelled' becomes the authorised 'void'
-- state. Voided invoices stay in history and are excluded from sales totals.
ALTER TABLE [dbo].[Invoices] DROP CONSTRAINT [Invoices_status_check];

UPDATE [dbo].[Invoices] SET [status] = 'void' WHERE [status] = 'cancelled';

ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_status_check]
    CHECK ([status] IN ('draft', 'issued', 'partially_paid', 'paid', 'void'));

/* ------------------------------------------------------------------ */
/* 3. Payments: optional method, actor, timestamps, guards             */
/* ------------------------------------------------------------------ */

-- The UI never requires a payment method and the invoice PDF never renders it.
ALTER TABLE [dbo].[InvoicePayments] ALTER COLUMN [method] NVARCHAR(30) NULL;

ALTER TABLE [dbo].[InvoicePayments] ADD [createdBy] INT NULL;

ALTER TABLE [dbo].[InvoicePayments] ADD [updatedAt] DATETIME2 NOT NULL
    CONSTRAINT [InvoicePayments_updatedAt_df] DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE [dbo].[InvoicePayments] ADD CONSTRAINT [InvoicePayments_status_check]
    CHECK ([status] IN ('pending', 'completed', 'failed'));

ALTER TABLE [dbo].[InvoicePayments] ADD CONSTRAINT [InvoicePayments_amount_check]
    CHECK ([amount] > 0);

/* ------------------------------------------------------------------ */
/* 4. Returns: customer, actors, timestamps, draft status, RET-0001    */
/* ------------------------------------------------------------------ */

ALTER TABLE [dbo].[InvoiceReturns] ADD
    [customerId] INT NULL,
    [createdBy]  INT NULL,
    [approvedBy] INT NULL,
    [approvedAt] DATETIME2 NULL,
    [updatedAt]  DATETIME2 NOT NULL CONSTRAINT [InvoiceReturns_updatedAt_df] DEFAULT CURRENT_TIMESTAMP;

-- 'pending' becomes the editable 'draft' state of the return lifecycle.
ALTER TABLE [dbo].[InvoiceReturns] DROP CONSTRAINT [InvoiceReturns_status_df];
ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_status_df] DEFAULT 'draft' FOR [status];

UPDATE [dbo].[InvoiceReturns] SET [status] = 'draft' WHERE [status] = 'pending';

ALTER TABLE [dbo].[InvoiceReturns] DROP CONSTRAINT [InvoiceReturns_status_check];
ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_status_check]
    CHECK ([status] IN ('draft', 'approved', 'rejected', 'cancelled'));

-- Human-facing reference format RET-0001. The mapping is injective, so the
-- unique index on returnNumber cannot be violated by the rewrite.
UPDATE [dbo].[InvoiceReturns]
SET [returnNumber] = 'RET-' + RIGHT('0000' + CAST([id] AS VARCHAR(10)), 4)
WHERE [id] <= 9999
  AND [returnNumber] LIKE 'RET-[0-9]%';

/* ------------------------------------------------------------------ */
/* 5. Return credit                                                    */
/* ------------------------------------------------------------------ */

CREATE TABLE [dbo].[ReturnCredits] (
    [id]             INT NOT NULL IDENTITY(1,1),
    [returnId]       INT NOT NULL,
    [invoiceId]      INT NOT NULL,
    [customerId]     INT NOT NULL,
    [approvedAmount] DECIMAL(18,2) NOT NULL,
    [approvedBy]     INT NULL,
    [approvedAt]     DATETIME2 NOT NULL,
    [createdAt]      DATETIME2 NOT NULL CONSTRAINT [ReturnCredits_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt]      DATETIME2 NOT NULL,
    CONSTRAINT [ReturnCredits_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ReturnCredits_returnId_key] UNIQUE NONCLUSTERED ([returnId]),
    CONSTRAINT [ReturnCredits_returnId_fkey] FOREIGN KEY ([returnId]) REFERENCES [dbo].[InvoiceReturns]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [ReturnCredits_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [ReturnCredits_customerId_fkey] FOREIGN KEY ([customerId]) REFERENCES [dbo].[Customers]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [ReturnCredits_approvedBy_fkey] FOREIGN KEY ([approvedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [ReturnCredits_amount_check] CHECK ([approvedAmount] > 0)
);

/* ------------------------------------------------------------------ */
/* 6. Refunds                                                          */
/* ------------------------------------------------------------------ */

CREATE TABLE [dbo].[Refunds] (
    [id]              INT NOT NULL IDENTITY(1,1),
    [returnId]        INT NOT NULL,
    [amount]          DECIMAL(18,2) NOT NULL,
    [status]          NVARCHAR(20) NOT NULL CONSTRAINT [Refunds_status_df] DEFAULT 'pending',
    [refundDate]      DATE NOT NULL,
    [referenceNumber] NVARCHAR(100) NULL,
    [notes]           NVARCHAR(1000) NULL,
    [createdBy]       INT NOT NULL,
    [completedBy]     INT NULL,
    [completedAt]     DATETIME2 NULL,
    [createdAt]       DATETIME2 NOT NULL CONSTRAINT [Refunds_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt]       DATETIME2 NOT NULL,
    CONSTRAINT [Refunds_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Refunds_returnId_fkey] FOREIGN KEY ([returnId]) REFERENCES [dbo].[InvoiceReturns]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [Refunds_createdBy_fkey] FOREIGN KEY ([createdBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [Refunds_completedBy_fkey] FOREIGN KEY ([completedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [Refunds_status_check] CHECK ([status] IN ('pending', 'completed', 'failed')),
    CONSTRAINT [Refunds_amount_check] CHECK ([amount] > 0)
);

/* ------------------------------------------------------------------ */
/* 7. Customer credit ledger                                           */
/* ------------------------------------------------------------------ */

CREATE TABLE [dbo].[CustomerCreditLedger] (
    [id]              INT NOT NULL IDENTITY(1,1),
    [customerId]      INT NOT NULL,
    [sourceReturnId]  INT NULL,
    [reversesEntryId] INT NULL,
    [entryType]       NVARCHAR(30) NOT NULL,
    [amount]          DECIMAL(18,2) NOT NULL,
    [reference]       NVARCHAR(100) NULL,
    [reason]          NVARCHAR(500) NULL,
    [createdBy]       INT NOT NULL,
    [createdAt]       DATETIME2 NOT NULL CONSTRAINT [CustomerCreditLedger_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CustomerCreditLedger_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CustomerCreditLedger_customerId_fkey] FOREIGN KEY ([customerId]) REFERENCES [dbo].[Customers]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CustomerCreditLedger_sourceReturnId_fkey] FOREIGN KEY ([sourceReturnId]) REFERENCES [dbo].[InvoiceReturns]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CustomerCreditLedger_reversesEntryId_fkey] FOREIGN KEY ([reversesEntryId]) REFERENCES [dbo].[CustomerCreditLedger]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CustomerCreditLedger_createdBy_fkey] FOREIGN KEY ([createdBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CustomerCreditLedger_entryType_check]
        CHECK ([entryType] IN ('credit_added', 'credit_applied', 'reversal_added', 'reversal_applied')),
    CONSTRAINT [CustomerCreditLedger_amount_check] CHECK ([amount] > 0)
);

/* ------------------------------------------------------------------ */
/* 8. Credit applications                                              */
/* ------------------------------------------------------------------ */

CREATE TABLE [dbo].[CreditApplications] (
    [id]                    INT NOT NULL IDENTITY(1,1),
    [customerCreditEntryId] INT NOT NULL,
    [customerId]            INT NOT NULL,
    [invoiceId]             INT NOT NULL,
    [amount]                DECIMAL(18,2) NOT NULL,
    [appliedBy]             INT NOT NULL,
    [appliedAt]             DATETIME2 NOT NULL CONSTRAINT [CreditApplications_appliedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [createdAt]             DATETIME2 NOT NULL CONSTRAINT [CreditApplications_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CreditApplications_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CreditApplications_customerCreditEntryId_fkey] FOREIGN KEY ([customerCreditEntryId]) REFERENCES [dbo].[CustomerCreditLedger]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditApplications_customerId_fkey] FOREIGN KEY ([customerId]) REFERENCES [dbo].[Customers]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditApplications_invoiceId_fkey] FOREIGN KEY ([invoiceId]) REFERENCES [dbo].[Invoices]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditApplications_appliedBy_fkey] FOREIGN KEY ([appliedBy]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT [CreditApplications_amount_check] CHECK ([amount] > 0)
);

/* ------------------------------------------------------------------ */
/* 9. Audit log                                                        */
/* ------------------------------------------------------------------ */

CREATE TABLE [dbo].[AuditLogs] (
    [id]                INT NOT NULL IDENTITY(1,1),
    [userId]            INT NULL,
    [userSnapshotName]  NVARCHAR(200) NULL,
    [userSnapshotEmail] NVARCHAR(320) NULL,
    [action]            NVARCHAR(60) NOT NULL,
    [documentType]      NVARCHAR(40) NOT NULL,
    [documentId]        INT NULL,
    [invoiceReference]  NVARCHAR(40) NULL,
    [beforeJson]        NVARCHAR(max) NULL,
    [afterJson]         NVARCHAR(max) NULL,
    [amount]            DECIMAL(18,2) NULL,
    [reason]            NVARCHAR(1000) NULL,
    [createdAt]         DATETIME2 NOT NULL CONSTRAINT [AuditLogs_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditLogs_pkey] PRIMARY KEY CLUSTERED ([id]),
    -- SET NULL keeps the audit row if an account is ever removed; the
    -- snapshot columns preserve the name/email regardless.
    CONSTRAINT [AuditLogs_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[Users]([id]) ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT [AuditLogs_documentType_check]
        CHECK ([documentType] IN ('invoice', 'payment', 'return', 'refund', 'credit_note', 'customer_credit', 'credit_application', 'user'))
);

/* ------------------------------------------------------------------ */
/* 10. Document counters                                               */
/* ------------------------------------------------------------------ */

-- One row per human-facing document sequence. The next number is claimed with
-- an atomic UPDATE inside the same transaction as the insert, so a rollback
-- also rolls the number back and two concurrent requests cannot receive the
-- same number. Invoice numbers keep using InvoiceCounters, which behaves the
-- same way.
CREATE TABLE [dbo].[DocumentCounters] (
    [key]       NVARCHAR(40) NOT NULL,
    [prefix]    NVARCHAR(10) NOT NULL,
    [nextValue] INT NOT NULL,
    CONSTRAINT [DocumentCounters_pkey] PRIMARY KEY CLUSTERED ([key])
);

INSERT INTO [dbo].[DocumentCounters] ([key], [prefix], [nextValue])
VALUES
    ('return', 'RET-', COALESCE((SELECT MAX([id]) + 1 FROM [dbo].[InvoiceReturns]), 1)),
    ('refund', 'RF-', COALESCE((SELECT MAX([id]) + 1 FROM [dbo].[Refunds]), 1));

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
