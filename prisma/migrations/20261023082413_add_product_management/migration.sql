BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Products] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [name] NVARCHAR(200) NOT NULL,
    [code] NVARCHAR(50) NOT NULL,
    [description] NVARCHAR(max),
    [unit] NVARCHAR(30),
    [price] DECIMAL(18,2) NOT NULL,
    [taxRate] DECIMAL(5,2) NOT NULL CONSTRAINT [Products_taxRate_df] DEFAULT 0,
    [stockQuantity] INT NOT NULL CONSTRAINT [Products_stockQuantity_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [Products_isActive_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Products_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Products_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Products_userId_code_key] UNIQUE NONCLUSTERED ([userId],[code])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Products_userId_createdAt_idx] ON [dbo].[Products]([userId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Products_userId_isActive_idx] ON [dbo].[Products]([userId], [isActive]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Products_userId_unit_idx] ON [dbo].[Products]([userId], [unit]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Products_userId_name_idx] ON [dbo].[Products]([userId], [name]);

-- AddForeignKey
ALTER TABLE [dbo].[Products] ADD CONSTRAINT [Products_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
