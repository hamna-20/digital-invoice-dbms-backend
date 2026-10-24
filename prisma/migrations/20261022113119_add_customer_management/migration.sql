BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Customers] (
    [id] INT NOT NULL IDENTITY(1,1),
    [userId] INT NOT NULL,
    [name] NVARCHAR(200) NOT NULL,
    [email] NVARCHAR(320),
    [phone] NVARCHAR(50),
    [companyName] NVARCHAR(200),
    [taxNumber] NVARCHAR(100),
    [address] NVARCHAR(500),
    [city] NVARCHAR(100),
    [notes] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Customers_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Customers_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Customers_userId_createdAt_idx] ON [dbo].[Customers]([userId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Customers_userId_city_idx] ON [dbo].[Customers]([userId], [city]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Customers_userId_name_idx] ON [dbo].[Customers]([userId], [name]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Customers_userId_companyName_idx] ON [dbo].[Customers]([userId], [companyName]);

-- AddForeignKey
ALTER TABLE [dbo].[Customers] ADD CONSTRAINT [Customers_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[Users]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
