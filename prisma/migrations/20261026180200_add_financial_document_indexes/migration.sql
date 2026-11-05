-- Creates the secondary indexes declared in the Prisma schema for the tables
-- introduced by 20261026180000_add_financial_documents_and_audit.
--
-- These are separated from part 1 so that the physical schema can be verified
-- against the datamodel with `prisma migrate diff` once all three migrations
-- have been applied.

BEGIN TRY

BEGIN TRAN;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ReturnCredits_customerId_idx' AND object_id = OBJECT_ID('[dbo].[ReturnCredits]'))
    CREATE NONCLUSTERED INDEX [ReturnCredits_customerId_idx] ON [dbo].[ReturnCredits]([customerId]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ReturnCredits_invoiceId_idx' AND object_id = OBJECT_ID('[dbo].[ReturnCredits]'))
    CREATE NONCLUSTERED INDEX [ReturnCredits_invoiceId_idx] ON [dbo].[ReturnCredits]([invoiceId]);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'CustomerCreditLedger_customerId_createdAt_idx' AND object_id = OBJECT_ID('[dbo].[CustomerCreditLedger]'))
    CREATE NONCLUSTERED INDEX [CustomerCreditLedger_customerId_createdAt_idx]
    ON [dbo].[CustomerCreditLedger]([customerId], [createdAt]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'CustomerCreditLedger_sourceReturnId_idx' AND object_id = OBJECT_ID('[dbo].[CustomerCreditLedger]'))
    CREATE NONCLUSTERED INDEX [CustomerCreditLedger_sourceReturnId_idx]
    ON [dbo].[CustomerCreditLedger]([sourceReturnId]);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'CreditApplications_invoiceId_idx' AND object_id = OBJECT_ID('[dbo].[CreditApplications]'))
    CREATE NONCLUSTERED INDEX [CreditApplications_invoiceId_idx] ON [dbo].[CreditApplications]([invoiceId]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'CreditApplications_customerId_idx' AND object_id = OBJECT_ID('[dbo].[CreditApplications]'))
    CREATE NONCLUSTERED INDEX [CreditApplications_customerId_idx] ON [dbo].[CreditApplications]([customerId]);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'AuditLogs_createdAt_idx' AND object_id = OBJECT_ID('[dbo].[AuditLogs]'))
    CREATE NONCLUSTERED INDEX [AuditLogs_createdAt_idx] ON [dbo].[AuditLogs]([createdAt]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'AuditLogs_userId_createdAt_idx' AND object_id = OBJECT_ID('[dbo].[AuditLogs]'))
    CREATE NONCLUSTERED INDEX [AuditLogs_userId_createdAt_idx] ON [dbo].[AuditLogs]([userId], [createdAt]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'AuditLogs_documentType_documentId_idx' AND object_id = OBJECT_ID('[dbo].[AuditLogs]'))
    CREATE NONCLUSTERED INDEX [AuditLogs_documentType_documentId_idx] ON [dbo].[AuditLogs]([documentType], [documentId]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'AuditLogs_action_idx' AND object_id = OBJECT_ID('[dbo].[AuditLogs]'))
    CREATE NONCLUSTERED INDEX [AuditLogs_action_idx] ON [dbo].[AuditLogs]([action]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
