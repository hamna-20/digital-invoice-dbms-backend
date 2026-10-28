-- Extends the immutable customer credit ledger so it can hold the entry types
-- of the payment/credit/return spec (H) and signed amounts.
--
--   entryType: adds issued, applied, return_credit, cashout, adjustment
--              alongside the four legacy values (nothing is removed, so all
--              existing rows stay valid).
--   amount:    was > 0; a return settlement clawbacks credit issued from an
--              invoice, which is an 'issued' entry with a negative amount.
--              Relaxed to <> 0 (zero-amount ledger rows remain pointless and
--              are rejected by the services).
--
-- Relaxing a CHECK only widens what is accepted — no existing row or query
-- changes behaviour.

ALTER TABLE [dbo].[CustomerCreditLedger] DROP CONSTRAINT [CustomerCreditLedger_entryType_check];
ALTER TABLE [dbo].[CustomerCreditLedger] ADD CONSTRAINT [CustomerCreditLedger_entryType_check]
    CHECK ([entryType] IN (
        'credit_added', 'credit_applied', 'reversal_added', 'reversal_applied',
        'issued', 'applied', 'return_credit', 'cashout', 'adjustment'
    ));

ALTER TABLE [dbo].[CustomerCreditLedger] DROP CONSTRAINT [CustomerCreditLedger_amount_check];
ALTER TABLE [dbo].[CustomerCreditLedger] ADD CONSTRAINT [CustomerCreditLedger_amount_check]
    CHECK ([amount] <> 0);