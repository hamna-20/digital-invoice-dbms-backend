-- Creates the secondary indexes declared in the Prisma schema for the tables
-- introduced by 20261026180000_add_financial_documents_and_audit.
--
-- These are separated from part 1 so that the physical schema can be verified
-- against the datamodel with `prisma migrate diff` once all three migrations
-- have been applied.

BEGIN TRY

BEGIN TRAN;

CREATE NONCLUSTERED INDEX [ReturnCredits_customerId_idx] ON [dbo].[ReturnCredits]([customerId]);
CREATE NONCLUSTERED INDEX [ReturnCredits_invoiceId_idx] ON [dbo].[ReturnCredits]([invoiceId]);

CREATE NONCLUSTERED INDEX [Refunds_returnId_status_idx] ON [dbo].[Refunds]([returnId], [status]);
CREATE NONCLUSTERED INDEX [Refunds_status_refundDate_idx] ON [dbo].[Refunds]([status], [refundDate]);

CREATE NONCLUSTERED INDEX [CustomerCreditLedger_customerId_createdAt_idx]
    ON [dbo].[CustomerCreditLedger]([customerId], [createdAt]);
CREATE NONCLUSTERED INDEX [CustomerCreditLedger_sourceReturnId_idx]
    ON [dbo].[CustomerCreditLedger]([sourceReturnId]);

CREATE NONCLUSTERED INDEX [CreditApplications_invoiceId_idx] ON [dbo].[CreditApplications]([invoiceId]);
CREATE NONCLUSTERED INDEX [CreditApplications_customerId_idx] ON [dbo].[CreditApplications]([customerId]);

CREATE NONCLUSTERED INDEX [AuditLogs_createdAt_idx] ON [dbo].[AuditLogs]([createdAt]);
CREATE NONCLUSTERED INDEX [AuditLogs_userId_createdAt_idx] ON [dbo].[AuditLogs]([userId], [createdAt]);
CREATE NONCLUSTERED INDEX [AuditLogs_documentType_documentId_idx] ON [dbo].[AuditLogs]([documentType], [documentId]);
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
