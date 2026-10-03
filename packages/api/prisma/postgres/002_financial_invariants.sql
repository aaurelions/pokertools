-- =============================================================================
-- 002_financial_invariants.sql — canonical multi-asset financial ledger
--
-- Applied on top of 001_initial_schema.sql, which Prisma generates directly
-- from prisma/schema.prisma (native PostgreSQL enums, tables, indexes and
-- composite foreign keys). This migration adds ONLY the invariants Prisma
-- cannot express:
--
--   * canonical decimal-string CHECK constraints on every atomic amount
--   * domain/canonicality CHECKs for the asset registry and custody records
--   * idempotent (re)assertion of the same-asset composite FKs + their
--     unique (id, assetId) targets
--   * immutability triggers on posted journal history (no UPDATE/DELETE)
--   * a posting-insert guard that refuses to extend a sealed transaction
--   * a DEFERRABLE INITIALLY DEFERRED constraint trigger proving every journal
--     transaction is sealed, has >= 2 postings, and sums to numeric zero at
--     COMMIT
--   * user-owned AtomicAccount balances may never go negative; system accounts
--     (ownerId IS NULL) may be explicitly debited negative
--   * EconomicPolicy exact one-chip representability
--   * FinancialIncident resolution consistency
--   * TreasuryReconciliation amount canonicality
--   * CustodyHeartbeat address/chain validation
--
-- All statements are idempotent/guarded (DROP CONSTRAINT/TRIGGER IF EXISTS then
-- ADD, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION) so the file
-- applies cleanly on a freshly generated baseline.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Asset registry — canonical id, address casing, ranges and domains
-- ---------------------------------------------------------------------------

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_id_canonical";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_id_canonical"
    CHECK ("id" ~ '^eip155:(0|[1-9][0-9]*)/erc20:0x[0-9a-f]{40}$');

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_chainId_positive";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_chainId_positive" CHECK ("chainId" > 0);

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_decimals_range";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_decimals_range"
    CHECK ("decimals" >= 0 AND "decimals" <= 255);

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_symbol_nonempty";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_symbol_nonempty" CHECK (char_length("symbol") > 0);

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_status_domain";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_status_domain"
    CHECK (("status")::text IN ('ACTIVE', 'DEGRADED', 'FROZEN'));

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_confirmations_nonnegative";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_confirmations_nonnegative" CHECK ("confirmations" >= 0);

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_finality_ge_confirmations";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_finality_ge_confirmations"
    CHECK ("deepFinality" >= "confirmations");

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_tokenAddress_lowercase";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_tokenAddress_lowercase"
    CHECK ("tokenAddress" ~ '^0x[0-9a-f]{40}$');

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_minGasAtomic_canonical";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_minGasAtomic_canonical"
    CHECK ("minGasAtomic" ~ '^(0|[1-9][0-9]*)$');

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_ledgerVersion_nonnegative";
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ledgerVersion_nonnegative" CHECK ("ledgerVersion" >= 0);

-- ---------------------------------------------------------------------------
-- Atomic accounts (cached balance projection)
-- ---------------------------------------------------------------------------

ALTER TABLE "AtomicAccount" DROP CONSTRAINT IF EXISTS "AtomicAccount_class_domain";
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_class_domain"
    CHECK (("class")::text IN (
        'USER_AVAILABLE', 'IN_PLAY_RESERVE', 'TOURNAMENT_RESERVE', 'PENDING_WITHDRAWAL',
        'TREASURY_RESERVE', 'OPERATOR', 'INCIDENT_OBLIGATION'
    ));

ALTER TABLE "AtomicAccount" DROP CONSTRAINT IF EXISTS "AtomicAccount_ownerKey_consistent";
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_ownerKey_consistent"
    CHECK ("ownerKey" = COALESCE("ownerId", '@system'));

ALTER TABLE "AtomicAccount" DROP CONSTRAINT IF EXISTS "AtomicAccount_balance_canonical";
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_balance_canonical"
    CHECK ("balanceAtomic" ~ '^(0|-?[1-9][0-9]*)$');

-- User liabilities may never be negative; system debits are explicit.
ALTER TABLE "AtomicAccount" DROP CONSTRAINT IF EXISTS "AtomicAccount_user_nonnegative";
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_user_nonnegative"
    CHECK ("ownerId" IS NULL OR ("balanceAtomic")::numeric >= 0);

ALTER TABLE "AtomicAccount" DROP CONSTRAINT IF EXISTS "AtomicAccount_version_nonnegative";
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_version_nonnegative" CHECK ("version" >= 0);

-- Unique (id, assetId) targets for the same-asset composite FKs. Present in the
-- generated baseline; re-asserted idempotently so 002 is self-contained.
CREATE UNIQUE INDEX IF NOT EXISTS "AtomicAccount_id_assetId_key"
    ON "AtomicAccount" ("id", "assetId");

-- ---------------------------------------------------------------------------
-- Journal transaction / posting
-- ---------------------------------------------------------------------------

ALTER TABLE "JournalTransaction" DROP CONSTRAINT IF EXISTS "JournalTransaction_payloadHash_nonempty";
ALTER TABLE "JournalTransaction" ADD CONSTRAINT "JournalTransaction_payloadHash_nonempty"
    CHECK (char_length("payloadHash") > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalTransaction_id_assetId_key"
    ON "JournalTransaction" ("id", "assetId");

ALTER TABLE "JournalPosting" DROP CONSTRAINT IF EXISTS "JournalPosting_amount_canonical";
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_amount_canonical"
    CHECK ("amountAtomic" ~ '^(0|-?[1-9][0-9]*)$');

ALTER TABLE "JournalPosting" DROP CONSTRAINT IF EXISTS "JournalPosting_amount_nonzero";
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_amount_nonzero"
    CHECK (("amountAtomic")::numeric <> 0);

-- Same-asset composite foreign keys: a posting, its transaction and its account
-- must all share one assetId. Present in the generated baseline; re-asserted
-- idempotently (drop + identical re-add) so 002 is self-contained.
ALTER TABLE "JournalPosting" DROP CONSTRAINT IF EXISTS "JournalPosting_transactionId_assetId_fkey";
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_transactionId_assetId_fkey"
    FOREIGN KEY ("transactionId", "assetId") REFERENCES "JournalTransaction" ("id", "assetId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalPosting" DROP CONSTRAINT IF EXISTS "JournalPosting_accountId_assetId_fkey";
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_accountId_assetId_fkey"
    FOREIGN KEY ("accountId", "assetId") REFERENCES "AtomicAccount" ("id", "assetId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Deposit claim records (exact log identity)
-- ---------------------------------------------------------------------------

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_status_domain";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_status_domain"
    CHECK (("status")::text IN ('OBSERVED', 'CONFIRMED', 'CREDITED', 'ORPHANED', 'FAILED'));

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_provenance_domain";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_provenance_domain"
    CHECK (("provenance")::text IN ('DIRECT_TREASURY'));

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_amount_canonical";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_amount_canonical"
    CHECK ("amountAtomic" ~ '^(0|[1-9][0-9]*)$');

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_logIndex_nonnegative";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_logIndex_nonnegative"
    CHECK ("logIndex" >= 0);

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_chainId_positive";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_chainId_positive"
    CHECK ("chainId" > 0);

ALTER TABLE "DepositClaimRecord" DROP CONSTRAINT IF EXISTS "DepositClaimRecord_txHash_format";
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_txHash_format"
    CHECK ("txHash" ~ '^0x[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Withdrawal intent records (EIP-712 bound; custody consumes)
-- ---------------------------------------------------------------------------

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_state_domain";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_state_domain"
    CHECK (("state")::text IN (
        'RESERVED', 'BLOCKED_GAS', 'SIGNED', 'PERSISTED', 'BROADCAST', 'AMBIGUOUS',
        'PENDING_CONFIRMATION', 'CONFIRMED', 'FINALIZED', 'REORGED', 'FAILED'
    ));

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_amount_canonical";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_amount_canonical"
    CHECK ("amountAtomic" ~ '^(0|[1-9][0-9]*)$');

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_amount_positive";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_amount_positive"
    CHECK (("amountAtomic")::numeric > 0);

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_nonce_nonnegative";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_nonce_nonnegative"
    CHECK ("nonce" >= 0);

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_destination_format";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_destination_format"
    CHECK ("destination" ~ '^0x[0-9a-f]{40}$');

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_signature_format";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_signature_format"
    CHECK ("signature" ~ '^0x[0-9a-fA-F]{130}$');

ALTER TABLE "WithdrawalIntentRecord" DROP CONSTRAINT IF EXISTS "WithdrawalIntentRecord_replacementPolicy_domain";
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_replacementPolicy_domain"
    CHECK (("replacementPolicy")::text IN ('NO_AUTOMATIC_REPLACEMENT'));

-- ---------------------------------------------------------------------------
-- Financial incidents (durable discrepancy; explicit operator resolution)
-- ---------------------------------------------------------------------------

ALTER TABLE "FinancialIncident" DROP CONSTRAINT IF EXISTS "FinancialIncident_kind_domain";
ALTER TABLE "FinancialIncident" ADD CONSTRAINT "FinancialIncident_kind_domain"
    CHECK (("kind")::text IN (
        'DEPOSIT_REORG', 'WITHDRAWAL_REORG', 'RPC_DISAGREEMENT', 'TREASURY_SHORTFALL',
        'GAS_STARVATION', 'AMBIGUOUS_CUSTODY_STATE',
        'AMBIGUOUS_BROADCAST', 'NONCE_CONFLICT', 'RECONCILIATION_MISMATCH',
        'RPC_QUORUM_FAILURE', 'NATIVE_GAS_LOW', 'LEDGER_IMBALANCE', 'CUSTODY_FAILURE'
    ));

ALTER TABLE "FinancialIncident" DROP CONSTRAINT IF EXISTS "FinancialIncident_severity_domain";
ALTER TABLE "FinancialIncident" ADD CONSTRAINT "FinancialIncident_severity_domain"
    CHECK (("severity")::text IN ('WARNING', 'CRITICAL'));

ALTER TABLE "FinancialIncident" DROP CONSTRAINT IF EXISTS "FinancialIncident_status_domain";
ALTER TABLE "FinancialIncident" ADD CONSTRAINT "FinancialIncident_status_domain"
    CHECK (("status")::text IN ('OPEN', 'INVESTIGATING', 'RESOLVED'));

ALTER TABLE "FinancialIncident" DROP CONSTRAINT IF EXISTS "FinancialIncident_version_nonnegative";
ALTER TABLE "FinancialIncident" ADD CONSTRAINT "FinancialIncident_version_nonnegative"
    CHECK ("version" >= 0);

ALTER TABLE "FinancialIncident" DROP CONSTRAINT IF EXISTS "FinancialIncident_resolution_consistent";
ALTER TABLE "FinancialIncident" ADD CONSTRAINT "FinancialIncident_resolution_consistent" CHECK (
    (("status")::text = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "operatorId" IS NOT NULL AND "operatorEvidence" IS NOT NULL)
    OR (("status")::text <> 'RESOLVED' AND "resolvedAt" IS NULL)
);

-- ---------------------------------------------------------------------------
-- Treasury reconciliation (persisted evidence)
-- ---------------------------------------------------------------------------

ALTER TABLE "TreasuryReconciliation" DROP CONSTRAINT IF EXISTS "TreasuryReconciliation_status_domain";
ALTER TABLE "TreasuryReconciliation" ADD CONSTRAINT "TreasuryReconciliation_status_domain"
    CHECK (("status")::text IN ('MATCHED', 'MISMATCH', 'UNVERIFIED'));

ALTER TABLE "TreasuryReconciliation" DROP CONSTRAINT IF EXISTS "TreasuryReconciliation_observed_canonical";
ALTER TABLE "TreasuryReconciliation" ADD CONSTRAINT "TreasuryReconciliation_observed_canonical"
    CHECK ("observedAtomic" ~ '^(0|[1-9][0-9]*)$');

ALTER TABLE "TreasuryReconciliation" DROP CONSTRAINT IF EXISTS "TreasuryReconciliation_ledger_canonical";
ALTER TABLE "TreasuryReconciliation" ADD CONSTRAINT "TreasuryReconciliation_ledger_canonical"
    CHECK ("ledgerAtomic" ~ '^(0|-?[1-9][0-9]*)$');

ALTER TABLE "TreasuryReconciliation" DROP CONSTRAINT IF EXISTS "TreasuryReconciliation_difference_canonical";
ALTER TABLE "TreasuryReconciliation" ADD CONSTRAINT "TreasuryReconciliation_difference_canonical"
    CHECK ("differenceAtomic" ~ '^(0|-?[1-9][0-9]*)$');

-- ---------------------------------------------------------------------------
-- Economic policy — exact one-chip representability
-- ---------------------------------------------------------------------------

ALTER TABLE "EconomicPolicy" DROP CONSTRAINT IF EXISTS "EconomicPolicy_terms_positive";
ALTER TABLE "EconomicPolicy" ADD CONSTRAINT "EconomicPolicy_terms_positive"
    CHECK ("chipsNumerator" > 0 AND "atomicDenominator" > 0);

-- Conservative production rule: one chip must map to a whole number of atomic
-- units so every integer chip amount converts exactly.
ALTER TABLE "EconomicPolicy" DROP CONSTRAINT IF EXISTS "EconomicPolicy_one_chip_representable";
ALTER TABLE "EconomicPolicy" ADD CONSTRAINT "EconomicPolicy_one_chip_representable"
    CHECK ("atomicDenominator" % "chipsNumerator" = 0);

-- ---------------------------------------------------------------------------
-- Custody heartbeat — public-key-only operational evidence
-- ---------------------------------------------------------------------------

ALTER TABLE "CustodyHeartbeat" DROP CONSTRAINT IF EXISTS "CustodyHeartbeat_chainId_positive";
ALTER TABLE "CustodyHeartbeat" ADD CONSTRAINT "CustodyHeartbeat_chainId_positive"
    CHECK ("chainId" > 0);

ALTER TABLE "CustodyHeartbeat" DROP CONSTRAINT IF EXISTS "CustodyHeartbeat_signerAddress_format";
ALTER TABLE "CustodyHeartbeat" ADD CONSTRAINT "CustodyHeartbeat_signerAddress_format"
    CHECK ("signerAddress" ~ '^0x[0-9a-f]{40}$');

-- ---------------------------------------------------------------------------
-- Immutability: posted journal history can never be updated or deleted.
-- ---------------------------------------------------------------------------

-- Journal transactions may be INSERTed and sealed exactly once (false->true),
-- never updated afterward or deleted. Postings are strictly append-only.
CREATE OR REPLACE FUNCTION "guard_journal_transaction"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'JOURNAL_IMMUTABLE: JournalTransaction is append-only';
    END IF;
    IF OLD."sealed" IS TRUE THEN
        RAISE EXCEPTION 'JOURNAL_IMMUTABLE: JournalTransaction % is already sealed', OLD."id";
    END IF;
    IF NEW."sealed" IS NOT TRUE THEN
        RAISE EXCEPTION 'JOURNAL_IMMUTABLE: only the sealed flag may be flipped to true';
    END IF;
    IF NEW."id" <> OLD."id"
       OR NEW."assetId" <> OLD."assetId"
       OR NEW."requestId" <> OLD."requestId"
       OR NEW."payloadHash" <> OLD."payloadHash"
       OR NEW."createdAt" <> OLD."createdAt" THEN
        RAISE EXCEPTION 'JOURNAL_IMMUTABLE: only the sealed flag may change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "reject_journal_posting_mutation"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'JOURNAL_IMMUTABLE: JournalPosting is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "JournalTransaction_guard" ON "JournalTransaction";
CREATE TRIGGER "JournalTransaction_guard"
    BEFORE UPDATE OR DELETE ON "JournalTransaction"
    FOR EACH ROW EXECUTE FUNCTION "guard_journal_transaction"();

DROP TRIGGER IF EXISTS "JournalPosting_immutable" ON "JournalPosting";
CREATE TRIGGER "JournalPosting_immutable"
    BEFORE UPDATE OR DELETE ON "JournalPosting"
    FOR EACH ROW EXECUTE FUNCTION "reject_journal_posting_mutation"();

-- ---------------------------------------------------------------------------
-- Posting insert guard: same asset AND the parent transaction must be unsealed.
-- This is what prevents inserting a second balanced pair into an already
-- committed historical JournalTransaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "guard_journal_posting_insert"() RETURNS trigger AS $$
DECLARE
    tx_asset TEXT;
    tx_sealed BOOLEAN;
    account_asset TEXT;
BEGIN
    SELECT "assetId", "sealed" INTO tx_asset, tx_sealed
        FROM "JournalTransaction" WHERE "id" = NEW."transactionId";
    SELECT "assetId" INTO account_asset FROM "AtomicAccount" WHERE "id" = NEW."accountId";
    IF tx_asset IS NULL OR account_asset IS NULL THEN
        RAISE EXCEPTION 'CROSS_ASSET_POSTING: missing transaction or account';
    END IF;
    IF tx_sealed IS TRUE THEN
        RAISE EXCEPTION 'JOURNAL_SEALED: transaction % already sealed', NEW."transactionId";
    END IF;
    IF tx_asset <> NEW."assetId" OR account_asset <> NEW."assetId" THEN
        RAISE EXCEPTION 'CROSS_ASSET_POSTING: posting asset mismatch';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "JournalPosting_insert_guard" ON "JournalPosting";
CREATE TRIGGER "JournalPosting_insert_guard"
    BEFORE INSERT ON "JournalPosting"
    FOR EACH ROW EXECUTE FUNCTION "guard_journal_posting_insert"();

-- ---------------------------------------------------------------------------
-- Balanced journal: at COMMIT every transaction must be sealed, have at least
-- two postings, and sum to numeric zero. DEFERRABLE INITIALLY DEFERRED so the
-- application may insert postings one at a time and seal afterwards. The same
-- function is fired from both the transaction and posting insert points, so a
-- transaction with no postings cannot commit either.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "assert_journal_balanced"() RETURNS trigger AS $$
DECLARE
    target_id TEXT;
    total NUMERIC;
    cnt INTEGER;
    is_sealed BOOLEAN;
BEGIN
    IF TG_TABLE_NAME = 'JournalPosting' THEN
        target_id := NEW."transactionId";
    ELSE
        target_id := NEW."id";
    END IF;

    SELECT COALESCE(SUM(("amountAtomic")::numeric), 0), COUNT(*)
        INTO total, cnt
        FROM "JournalPosting" WHERE "transactionId" = target_id;
    SELECT "sealed" INTO is_sealed FROM "JournalTransaction" WHERE "id" = target_id;
    IF is_sealed IS NULL THEN
        RAISE EXCEPTION 'JOURNAL_NOT_BALANCED: missing transaction %', target_id;
    END IF;
    IF is_sealed IS NOT TRUE THEN
        RAISE EXCEPTION 'JOURNAL_NOT_SEALED: transaction % must be sealed', target_id;
    END IF;
    IF cnt < 2 THEN
        RAISE EXCEPTION 'JOURNAL_NOT_BALANCED: transaction % has % postings', target_id, cnt;
    END IF;
    IF total <> 0 THEN
        RAISE EXCEPTION 'JOURNAL_NOT_BALANCED: transaction % sums to %', target_id, total;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "JournalPosting_balanced" ON "JournalPosting";
CREATE CONSTRAINT TRIGGER "JournalPosting_balanced"
    AFTER INSERT ON "JournalPosting"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "assert_journal_balanced"();

DROP TRIGGER IF EXISTS "JournalTransaction_balanced" ON "JournalTransaction";
CREATE CONSTRAINT TRIGGER "JournalTransaction_balanced"
    AFTER INSERT ON "JournalTransaction"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "assert_journal_balanced"();

-- ---------------------------------------------------------------------------
-- User liability floor: user-owned cached balances may never go negative.
-- System accounts (ownerId IS NULL) are permitted explicit negative debits.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "assert_account_nonnegative"() RETURNS trigger AS $$
BEGIN
    IF NEW."ownerId" IS NOT NULL AND (NEW."balanceAtomic")::numeric < 0 THEN
        RAISE EXCEPTION 'ACCOUNT_NEGATIVE: user account % may not go negative', NEW."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AtomicAccount_nonnegative" ON "AtomicAccount";
CREATE TRIGGER "AtomicAccount_nonnegative"
    BEFORE INSERT OR UPDATE ON "AtomicAccount"
    FOR EACH ROW EXECUTE FUNCTION "assert_account_nonnegative"();
