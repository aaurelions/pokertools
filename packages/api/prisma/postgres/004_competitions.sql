-- ============================================================================
-- 004_competitions — competition economic invariants, canonical entry
-- lifecycle and durable SERVICE table-credential binding.
--
-- Relational DDL (enums, tables, indexes, foreign keys, the cancellation
-- timestamp and the lifecycle journal columns) is generated from
-- prisma/schema.prisma into 001_initial_schema.sql. This migration adds ONLY
-- the hand-written invariants Prisma cannot express:
--
--   * Competition terms are mode-consistent: NONFINANCIAL carries no asset
--     terms and no sponsor; ASSET carries complete, positive, canonical
--     atomic entry/prize terms and an authorized sponsor reference.
--   * SERVICE entrants are always zero-entry (never PENDING/PAID, no amount).
--   * Cancellation is terminal and carries its timestamp exactly when the
--     competition is CANCELLED.
--   * The canonical entry lifecycle: PAID/REFUNDED always carry the exact
--     reserve-credit entry journal, REFUNDED carries its refund journal, and
--     only a PAID entry may carry the sponsor settlement journal.
--   * A non-revoked table-scoped SERVICE credential must be bound to a
--     non-empty tableId; revoked historical rows keep their metadata without
--     any authority, and orchestration credentials are untouched.
--
-- Fresh-install baseline: applied to an empty database after 001..003.
-- Immutable: never edit after release.
-- ============================================================================

-- Competition terms ----------------------------------------------------------

ALTER TABLE "Competition" ADD CONSTRAINT "Competition_startingStack_positive"
    CHECK ("startingStack" > 0);
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_idempotency_identity"
    CHECK (char_length("idempotencyKey") > 0 AND char_length("requestHash") > 0);
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_blinds_positive"
    CHECK ("smallBlind" > 0 AND "bigBlind" > 0);

-- NONFINANCIAL carries no terms at all; ASSET carries complete terms.
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_terms_mode_consistent"
    CHECK (
        (
            "mode" = 'NONFINANCIAL'
            AND "entryAssetId" IS NULL
            AND "entryAmountAtomic" IS NULL
            AND "prizeAssetId" IS NULL
            AND "prizeAmountAtomic" IS NULL
            AND "sponsorId" IS NULL
            AND "prizeStatus" = 'NOT_APPLICABLE'
        )
        OR (
            "mode" = 'ASSET'
            AND "entryAssetId" IS NOT NULL
            AND "entryAmountAtomic" IS NOT NULL
            AND "prizeAssetId" IS NOT NULL
            AND "prizeAmountAtomic" IS NOT NULL
            AND "sponsorId" IS NOT NULL
        )
    );

ALTER TABLE "Competition" ADD CONSTRAINT "Competition_entryAmount_canonical_positive"
    CHECK ("entryAmountAtomic" IS NULL OR "entryAmountAtomic" ~ '^[1-9][0-9]*$');
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_prizeAmount_canonical_positive"
    CHECK ("prizeAmountAtomic" IS NULL OR "prizeAmountAtomic" ~ '^[1-9][0-9]*$');

-- A prize can only be reserved/paid/released for funded ASSET competitions.
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_prizeStatus_funded"
    CHECK (
        "prizeStatus" IN ('NOT_APPLICABLE', 'RESERVED', 'PAID', 'RELEASED')
        AND ("prizeStatus" = 'NOT_APPLICABLE') = ("mode" = 'NONFINANCIAL')
    );

-- Cancellation is terminal and carries its timestamp exactly when CANCELLED.
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_cancelled_requires_timestamp"
    CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- Entrants -------------------------------------------------------------------

ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_seat_range"
    CHECK ("seat" >= 0 AND "seat" <= 9);

-- SERVICE entrants are always zero-entry and never financial owners.
ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_service_zero_entry"
    CHECK (
        "kind" <> 'SERVICE'
        OR ("entryState" = 'NOT_REQUIRED' AND "entryAmountAtomic" IS NULL AND "entryJournalId" IS NULL)
    );

-- Canonical entry lifecycle: PAID/REFUNDED always carry the exact reserve-credit
-- entry journal; REFUNDED additionally carries its refund journal and can never
-- carry a settlement journal (only a prestart cancellation refunds, and a
-- cancelled competition never transfers entries to the sponsor).
ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_entry_lifecycle"
    CHECK (
        ("entryState" IN ('PAID', 'REFUNDED')) = ("entryJournalId" IS NOT NULL)
        AND ("entryState" = 'REFUNDED') = ("refundJournalId" IS NOT NULL)
        AND ("entrySettlementJournalId" IS NULL OR "entryState" = 'PAID')
    );

-- SERVICE table-credential binding -------------------------------------------
-- A non-revoked table-scoped credential must carry a non-empty bound tableId.
-- `scopes` is JSONB and always a JSON array of scope strings, so the JSONB
-- `?|` existence operator is a safe shape test here. Revoked historical rows
-- are exempt so public summaries may keep their original metadata without
-- retaining any authority.
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_table_binding"
    CHECK (
        "revoked" = TRUE
        OR ("tableId" IS NOT NULL AND char_length("tableId") > 0)
        OR NOT ("scopes" ?| ARRAY['table:observe', 'table:act', 'table:chat']::text[])
    );
