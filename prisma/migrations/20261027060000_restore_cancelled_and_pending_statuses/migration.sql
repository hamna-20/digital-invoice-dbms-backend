-- Restores the simpler lifecycle vocabulary the maintained API contract uses:
--   * an invoice can be cancelled by any staff member (in addition to the
--     authorised manager void workflow), so 'cancelled' is a valid stored state;
--   * a return starts life as 'pending' and only becomes approved/rejected/
--     cancelled once someone decides it.
--
-- Existing rows keep their current values: both migrations add the new values
-- to the allowed set rather than rewriting data.

ALTER TABLE [dbo].[Invoices] DROP CONSTRAINT IF EXISTS [Invoices_status_check];
ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_status_check]
    CHECK ([status] IN ('draft', 'issued', 'partially_paid', 'paid', 'cancelled', 'void'));

ALTER TABLE [dbo].[InvoiceReturns] DROP CONSTRAINT IF EXISTS [InvoiceReturns_status_check];
ALTER TABLE [dbo].[InvoiceReturns] ADD CONSTRAINT [InvoiceReturns_status_check]
    CHECK ([status] IN ('pending', 'draft', 'approved', 'rejected', 'cancelled'));
