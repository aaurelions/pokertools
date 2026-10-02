-- ============================================================================
-- 004_competitions — generic competition provisioning, explicit ASSET terms
-- and durable SERVICE principal credentials/delegation.
--
-- Relational DDL is generated offline from prisma/schema.prisma
-- (prisma migrate diff) and reviewed; the CHECK constraints below are the
-- hand-written economic invariants Prisma cannot express:
--
--   * Competition terms are mode-consistent: NONFINANCIAL carries no asset
--     terms and no sponsor; ASSET carries complete, positive, canonical
--     atomic entry/prize terms and an authorized sponsor reference.
--   * SERVICE entrants are always zero-entry (never PENDING/PAID, no amount).
--   * A PAID entrant always carries the journal that committed its entry.
--   * ServiceCredential no longer forces one credential per principal:
--     a durable SERVICE principal may hold one table-scoped credential per
--     room. Rotating or adding credentials never changes principalId.
--
-- Immutable: never edit after release; add a higher-numbered migration.
-- ============================================================================

-- CreateEnum
CREATE TYPE "CompetitionMode" AS ENUM ('NONFINANCIAL', 'ASSET');

-- CreateEnum
CREATE TYPE "CompetitionStatus" AS ENUM ('REGISTRATION', 'RUNNING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CompetitionEntryState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PAID');

-- CreateEnum
CREATE TYPE "CompetitionPrizeStatus" AS ENUM ('NOT_APPLICABLE', 'RESERVED', 'PAID', 'RELEASED');

-- DropIndex
-- One credential per principal is no longer required: an agent may hold one
-- table-scoped credential per room while retaining a stable principalId.
DROP INDEX "ServiceCredential_userId_key";

-- CreateTable
CREATE TABLE "ServicePrincipalDelegation" (
    "id" TEXT NOT NULL,
    "servicePrincipalId" TEXT NOT NULL,
    "delegatePrincipalId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePrincipalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "CompetitionMode" NOT NULL,
    "status" "CompetitionStatus" NOT NULL DEFAULT 'REGISTRATION',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "startingStack" INTEGER NOT NULL,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "entryAssetId" TEXT,
    "entryAmountAtomic" TEXT,
    "prizeAssetId" TEXT,
    "prizeAmountAtomic" TEXT,
    "sponsorId" TEXT,
    "prizeStatus" "CompetitionPrizeStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "prizeReservationJournalId" TEXT,
    "prizeSettlementJournalId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionEntrant" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "seat" INTEGER NOT NULL,
    "entryState" "CompetitionEntryState" NOT NULL DEFAULT 'NOT_REQUIRED',
    "entryAmountAtomic" TEXT,
    "entryJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionEntrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServicePrincipalDelegation_servicePrincipalId_key" ON "ServicePrincipalDelegation"("servicePrincipalId");

-- CreateIndex
CREATE INDEX "ServicePrincipalDelegation_delegatePrincipalId_idx" ON "ServicePrincipalDelegation"("delegatePrincipalId");

-- CreateIndex
CREATE INDEX "ServicePrincipalDelegation_delegatePrincipalId_revokedAt_idx" ON "ServicePrincipalDelegation"("delegatePrincipalId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_organizerId_idempotencyKey_key" ON "Competition"("organizerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_tournamentId_key" ON "Competition"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_prizeReservationJournalId_key" ON "Competition"("prizeReservationJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "Competition_prizeSettlementJournalId_key" ON "Competition"("prizeSettlementJournalId");

-- CreateIndex
CREATE INDEX "Competition_status_createdAt_idx" ON "Competition"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Competition_organizerId_idx" ON "Competition"("organizerId");

-- CreateIndex
CREATE INDEX "Competition_sponsorId_idx" ON "Competition"("sponsorId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionEntrant_entryJournalId_key" ON "CompetitionEntrant"("entryJournalId");

-- CreateIndex
CREATE INDEX "CompetitionEntrant_principalId_idx" ON "CompetitionEntrant"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionEntrant_competitionId_principalId_key" ON "CompetitionEntrant"("competitionId", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionEntrant_competitionId_seat_key" ON "CompetitionEntrant"("competitionId", "seat");

-- CreateIndex
CREATE INDEX "ServiceCredential_userId_revoked_idx" ON "ServiceCredential"("userId", "revoked");

-- AddForeignKey
ALTER TABLE "ServicePrincipalDelegation" ADD CONSTRAINT "ServicePrincipalDelegation_servicePrincipalId_fkey" FOREIGN KEY ("servicePrincipalId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePrincipalDelegation" ADD CONSTRAINT "ServicePrincipalDelegation_delegatePrincipalId_fkey" FOREIGN KEY ("delegatePrincipalId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written economic invariants ------------------------------------------

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

ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_seat_range"
    CHECK ("seat" >= 0 AND "seat" <= 9);

-- SERVICE entrants are always zero-entry and never financial owners.
ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_service_zero_entry"
    CHECK (
        "kind" <> 'SERVICE'
        OR ("entryState" = 'NOT_REQUIRED' AND "entryAmountAtomic" IS NULL AND "entryJournalId" IS NULL)
    );

ALTER TABLE "CompetitionEntrant" ADD CONSTRAINT "CompetitionEntrant_paid_requires_journal"
    CHECK (("entryState" = 'PAID') = ("entryJournalId" IS NOT NULL));
