-- Additive index only. The FBR mock review reads customer credit entries by
-- source invoice; this index keeps that lookup cheap without touching data.
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'CustomerCreditLedger_sourceInvoiceId_idx'
      AND object_id = OBJECT_ID('dbo.CustomerCreditLedger')
)
BEGIN
    CREATE NONCLUSTERED INDEX [CustomerCreditLedger_sourceInvoiceId_idx]
        ON [dbo].[CustomerCreditLedger]([sourceInvoiceId]);
END;
