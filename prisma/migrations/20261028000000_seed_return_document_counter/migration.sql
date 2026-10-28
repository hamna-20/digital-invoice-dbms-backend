-- Seeds the return document sequence if it does not exist yet. The counter is
-- claimed with an atomic UPDATE inside the same transaction as each return
-- insert, so a rollback also rolls the number back. Existing counters (for
-- example the one created by 20261026180000_add_financial_documents_and_audit)
-- are left untouched.
IF NOT EXISTS (SELECT 1 FROM [dbo].[DocumentCounters] WHERE [key] = 'return')
BEGIN
    INSERT INTO [dbo].[DocumentCounters] ([key], [prefix], [nextValue])
    VALUES ('return', 'RET-', 1);
END
