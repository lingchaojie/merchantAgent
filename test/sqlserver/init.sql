USE master;
GO

IF DB_ID(N'merchant_test') IS NOT NULL
BEGIN
  ALTER DATABASE merchant_test SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE merchant_test;
END;
GO

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'merchant_agent_test')
  DROP LOGIN merchant_agent_test;
GO

CREATE DATABASE merchant_test;
GO
CREATE LOGIN merchant_agent_test WITH PASSWORD = 'M7SqlTest!2026', CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF;
GO

USE merchant_test;
GO

CREATE TABLE dbo.production_orders (
  order_id nvarchar(64) NOT NULL CONSTRAINT PK_production_orders PRIMARY KEY,
  work_order_id nvarchar(64) NOT NULL,
  status nvarchar(32) NOT NULL,
  promise_date date NOT NULL,
  completion_rate int NOT NULL,
  note nvarchar(256) NULL,
  version int NOT NULL
);
GO

INSERT dbo.production_orders (order_id, work_order_id, status, promise_date, completion_rate, note, version)
VALUES
  (N'ORD-1001', N'WO-2001', N'in_production', '2026-07-20', 45, N'fixture row one', 1),
  (N'ORD-1002', N'WO-2002', N'queued', '2026-07-24', 0, NULL, 1);
GO

CREATE USER merchant_agent_test FOR LOGIN merchant_agent_test;
GRANT SELECT ON OBJECT::dbo.production_orders TO merchant_agent_test;
GRANT UPDATE (completion_rate, note, version) ON OBJECT::dbo.production_orders TO merchant_agent_test;
GO
