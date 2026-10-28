ALTER TABLE [dbo].[Invoices] DROP CONSTRAINT [Invoices_status_check];

ALTER TABLE [dbo].[Invoices] ADD CONSTRAINT [Invoices_status_check]
    CHECK ([status] IN ('draft', 'issued', 'partially_paid', 'paid', 'cancelled'));
