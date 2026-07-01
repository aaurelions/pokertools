-- 002_house_system_accounts.sql
--
-- Records the HOUSE_RESERVE and TOURNAMENT_ESCROW AccountType values used as
-- the double-entry counterparty for external money flows and tournament escrow.
--
-- Account.type is a plain TEXT column (not a PostgreSQL enum type), so no DDL
-- change is required to accept the new values; they are validated by the
-- Prisma client. The HOUSE user and its system accounts are created
-- idempotently by the application seed (prisma/seed.ts), since the house
-- user's id is a generated CUID that cannot be known at migration time.

SELECT 1;