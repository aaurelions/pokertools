-- Finance/security hardening migration.
-- Adds DB-level idempotency support for withdrawal requests. Nullable unique
-- column preserves existing deposit rows and allows multiple NULL values in
-- SQLite/PostgreSQL while preventing duplicate non-null request keys.

ALTER TABLE "PaymentTransaction" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "PaymentTransaction_idempotencyKey_key" ON "PaymentTransaction"("idempotencyKey");
