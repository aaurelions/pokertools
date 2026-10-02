-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLAYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PrincipalKind" AS ENUM ('WALLET', 'SERVICE');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('REGISTRATION', 'RUNNING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TournamentEntryStatus" AS ENUM ('REGISTERED', 'ACTIVE', 'ELIMINATED', 'PAID');

-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('CASH', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('WAITING', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'FROZEN');

-- CreateEnum
CREATE TYPE "AtomicAccountClass" AS ENUM ('USER_AVAILABLE', 'IN_PLAY_RESERVE', 'TOURNAMENT_RESERVE', 'PENDING_WITHDRAWAL', 'TREASURY_RESERVE', 'OPERATOR', 'INCIDENT_OBLIGATION');

-- CreateEnum
CREATE TYPE "DepositClaimStatus" AS ENUM ('OBSERVED', 'CONFIRMED', 'CREDITED', 'ORPHANED', 'FAILED');

-- CreateEnum
CREATE TYPE "DepositProvenance" AS ENUM ('DIRECT_TREASURY', 'SWEEP', 'MIGRATION');

-- CreateEnum
CREATE TYPE "WithdrawalIntentState" AS ENUM ('RESERVED', 'BLOCKED_GAS', 'SIGNED', 'PERSISTED', 'BROADCAST', 'AMBIGUOUS', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FINALIZED', 'REORGED', 'FAILED');

-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('DEPOSIT_REORG', 'WITHDRAWAL_REORG', 'RPC_DISAGREEMENT', 'TREASURY_SHORTFALL', 'GAS_STARVATION', 'AMBIGUOUS_CUSTODY_STATE', 'AMBIGUOUS_BROADCAST', 'NONCE_CONFLICT', 'RECONCILIATION_MISMATCH', 'RPC_QUORUM_FAILURE', 'NATIVE_GAS_LOW', 'LEDGER_IMBALANCE', 'CUSTODY_FAILURE');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('MATCHED', 'MISMATCH', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "ChipAccountKind" AS ENUM ('AVAILABLE', 'TABLE_RESERVE', 'TOURNAMENT_RESERVE', 'OPERATOR');

-- CreateEnum
CREATE TYPE "ChipEntryType" AS ENUM ('GRANT', 'TRANSFER_IN', 'TRANSFER_OUT', 'BUY_IN', 'CASH_OUT', 'HAND_WIN', 'HAND_LOSS', 'RAKE', 'TOURNAMENT_BUY_IN', 'TOURNAMENT_FEE', 'TOURNAMENT_PAYOUT', 'TOURNAMENT_REFUND');

-- CreateEnum
CREATE TYPE "EconomicPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'FROZEN', 'RETIRED');

-- CreateEnum
CREATE TYPE "ChipAssetConversionDirection" AS ENUM ('CHIPS_TO_ATOMIC', 'ATOMIC_TO_CHIPS', 'SETTLEMENT_WIN', 'SETTLEMENT_LOSS', 'TOURNAMENT_FEE', 'TOURNAMENT_PAYOUT');

-- CreateEnum
CREATE TYPE "ChipAssetConversionStatus" AS ENUM ('PENDING', 'COMMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "address" TEXT,
    "role" "Role" NOT NULL DEFAULT 'PLAYER',
    "kind" "PrincipalKind" NOT NULL DEFAULT 'WALLET',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "tableId" TEXT,
    "seat" INTEGER,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "GameMode" NOT NULL,
    "status" "TableStatus" NOT NULL DEFAULT 'WAITING',
    "config" JSONB NOT NULL,
    "state" JSONB,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "eventSeq" INTEGER NOT NULL DEFAULT 0,
    "tournamentId" TEXT,
    "economicPolicyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'REGISTRATION',
    "creatorId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "buyIn" INTEGER NOT NULL,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "startingStack" INTEGER NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "tableMaxPlayers" INTEGER NOT NULL DEFAULT 10,
    "balancingTolerance" INTEGER NOT NULL DEFAULT 2,
    "prizePool" INTEGER NOT NULL DEFAULT 0,
    "blindStructure" JSONB NOT NULL,
    "payoutPercentages" JSONB NOT NULL,
    "economicPolicyId" TEXT,
    "startsAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "lastBlindAdvancedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentEntry" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "status" "TournamentEntryStatus" NOT NULL DEFAULT 'REGISTERED',
    "placement" INTEGER,
    "prize" INTEGER NOT NULL DEFAULT 0,
    "currentTableId" TEXT,
    "currentSeat" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandHistory" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerNote" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "response" JSONB,
    "statusCode" INTEGER,
    "errorCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "confirmations" INTEGER NOT NULL DEFAULT 12,
    "deepFinality" INTEGER NOT NULL DEFAULT 24,
    "treasuryAddress" TEXT NOT NULL,
    "rpcUrls" JSONB NOT NULL,
    "minGasAtomic" TEXT NOT NULL,
    "ledgerVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtomicAccount" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerKey" TEXT NOT NULL,
    "class" "AtomicAccountClass" NOT NULL,
    "balanceAtomic" TEXT NOT NULL DEFAULT '0',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtomicAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalTransaction" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalPosting" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositClaimRecord" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "blockNumber" TEXT,
    "blockHash" TEXT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "status" "DepositClaimStatus" NOT NULL DEFAULT 'OBSERVED',
    "provenance" "DepositProvenance" NOT NULL DEFAULT 'DIRECT_TREASURY',
    "creditedJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositClaimRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalIntentRecord" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "destination" TEXT NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "deadline" BIGINT NOT NULL,
    "signature" TEXT NOT NULL,
    "state" "WithdrawalIntentState" NOT NULL DEFAULT 'RESERVED',
    "reservedJournalId" TEXT,
    "payloadHash" TEXT,
    "signedRawTx" TEXT,
    "signedCallData" TEXT,
    "signedValueAtomic" TEXT,
    "txHash" TEXT,
    "broadcastNonce" BIGINT,
    "receiptBlockNumber" TEXT,
    "receiptBlockHash" TEXT,
    "confirmedJournalId" TEXT,
    "reorgJournalId" TEXT,
    "replacementPolicy" TEXT NOT NULL DEFAULT 'NO_AUTOMATIC_REPLACEMENT',
    "treasuryAddress" TEXT,
    "tokenAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalIntentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialIncident" (
    "id" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "assetId" TEXT,
    "chainId" INTEGER,
    "affectedId" TEXT,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "operatorId" TEXT,
    "operatorEvidence" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryReconciliation" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "observedAtomic" TEXT NOT NULL,
    "ledgerAtomic" TEXT NOT NULL,
    "differenceAtomic" TEXT NOT NULL,
    "blockNumber" TEXT,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "evidence" JSONB NOT NULL,
    "incidentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEvent" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "turnId" TEXT,
    "requestId" TEXT,
    "actionId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "previousHash" TEXT,
    "hash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameActionRequest" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "response" JSONB,
    "resultVersion" INTEGER,
    "eventSeq" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameOutbox" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentEvent" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "eventSeq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "stateFingerprint" TEXT NOT NULL,
    "requestRef" TEXT,
    "previousHash" TEXT,
    "hash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChipAccount" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "kind" "ChipAccountKind" NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '@owner',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChipAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChipLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "type" "ChipEntryType" NOT NULL,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChipLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChipGrant" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChipGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "chipsNumerator" BIGINT NOT NULL,
    "atomicDenominator" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "EconomicPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChipAssetConversion" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "economicPolicyId" TEXT NOT NULL,
    "direction" "ChipAssetConversionDirection" NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "chipAmount" BIGINT NOT NULL,
    "atomicAmount" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "journalRequestId" TEXT NOT NULL,
    "status" "ChipAssetConversionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChipAssetConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChipAssetSettlement" (
    "id" TEXT NOT NULL,
    "economicPolicyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "journalRequestId" TEXT NOT NULL,
    "rakeAtomic" TEXT NOT NULL DEFAULT '0',
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChipAssetSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyHeartbeat" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "signerAddress" TEXT NOT NULL,
    "signerReady" BOOLEAN NOT NULL,
    "gasReady" BOOLEAN NOT NULL,
    "workerId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_address_key" ON "User"("address");

-- CreateIndex
CREATE INDEX "User_address_idx" ON "User"("address");

-- CreateIndex
CREATE INDEX "User_kind_idx" ON "User"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCredential_userId_key" ON "ServiceCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCredential_keyHash_key" ON "ServiceCredential"("keyHash");

-- CreateIndex
CREATE INDEX "ServiceCredential_userId_idx" ON "ServiceCredential"("userId");

-- CreateIndex
CREATE INDEX "ServiceCredential_createdById_idx" ON "ServiceCredential"("createdById");

-- CreateIndex
CREATE INDEX "ServiceCredential_revoked_idx" ON "ServiceCredential"("revoked");

-- CreateIndex
CREATE INDEX "ServiceCredential_tableId_idx" ON "ServiceCredential"("tableId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_jti_key" ON "Session"("jti");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_jti_idx" ON "Session"("jti");

-- CreateIndex
CREATE INDEX "Table_status_idx" ON "Table"("status");

-- CreateIndex
CREATE INDEX "Table_tournamentId_idx" ON "Table"("tournamentId");

-- CreateIndex
CREATE INDEX "Table_economicPolicyId_idx" ON "Table"("economicPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_tableId_key" ON "Tournament"("tableId");

-- CreateIndex
CREATE INDEX "Tournament_status_createdAt_idx" ON "Tournament"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Tournament_creatorId_idx" ON "Tournament"("creatorId");

-- CreateIndex
CREATE INDEX "Tournament_economicPolicyId_idx" ON "Tournament"("economicPolicyId");

-- CreateIndex
CREATE INDEX "TournamentEntry_userId_status_idx" ON "TournamentEntry"("userId", "status");

-- CreateIndex
CREATE INDEX "TournamentEntry_currentTableId_idx" ON "TournamentEntry"("currentTableId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEntry_tournamentId_userId_key" ON "TournamentEntry"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEntry_tournamentId_seat_key" ON "TournamentEntry"("tournamentId", "seat");

-- CreateIndex
CREATE INDEX "HandHistory_tableId_timestamp_idx" ON "HandHistory"("tableId", "timestamp");

-- CreateIndex
CREATE INDEX "PlayerNote_authorId_idx" ON "PlayerNote"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerNote_authorId_targetId_key" ON "PlayerNote"("authorId", "targetId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_userId_scope_idx" ON "IdempotencyRecord"("userId", "scope");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resource_idx" ON "AuditLog"("resource");

-- CreateIndex
CREATE INDEX "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_chainId_tokenAddress_key" ON "Asset"("chainId", "tokenAddress");

-- CreateIndex
CREATE INDEX "AtomicAccount_assetId_idx" ON "AtomicAccount"("assetId");

-- CreateIndex
CREATE INDEX "AtomicAccount_ownerId_idx" ON "AtomicAccount"("ownerId");

-- CreateIndex
CREATE INDEX "AtomicAccount_assetId_class_idx" ON "AtomicAccount"("assetId", "class");

-- CreateIndex
CREATE UNIQUE INDEX "AtomicAccount_id_assetId_key" ON "AtomicAccount"("id", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AtomicAccount_assetId_ownerKey_class_key" ON "AtomicAccount"("assetId", "ownerKey", "class");

-- CreateIndex
CREATE UNIQUE INDEX "JournalTransaction_requestId_key" ON "JournalTransaction"("requestId");

-- CreateIndex
CREATE INDEX "JournalTransaction_assetId_createdAt_idx" ON "JournalTransaction"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalTransaction_id_assetId_key" ON "JournalTransaction"("id", "assetId");

-- CreateIndex
CREATE INDEX "JournalPosting_transactionId_idx" ON "JournalPosting"("transactionId");

-- CreateIndex
CREATE INDEX "JournalPosting_accountId_idx" ON "JournalPosting"("accountId");

-- CreateIndex
CREATE INDEX "JournalPosting_assetId_idx" ON "JournalPosting"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositClaimRecord_creditedJournalId_key" ON "DepositClaimRecord"("creditedJournalId");

-- CreateIndex
CREATE INDEX "DepositClaimRecord_principalId_assetId_idx" ON "DepositClaimRecord"("principalId", "assetId");

-- CreateIndex
CREATE INDEX "DepositClaimRecord_status_idx" ON "DepositClaimRecord"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DepositClaimRecord_chainId_txHash_logIndex_key" ON "DepositClaimRecord"("chainId", "txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalIntentRecord_reservedJournalId_key" ON "WithdrawalIntentRecord"("reservedJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalIntentRecord_txHash_key" ON "WithdrawalIntentRecord"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalIntentRecord_confirmedJournalId_key" ON "WithdrawalIntentRecord"("confirmedJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalIntentRecord_reorgJournalId_key" ON "WithdrawalIntentRecord"("reorgJournalId");

-- CreateIndex
CREATE INDEX "WithdrawalIntentRecord_principalId_idx" ON "WithdrawalIntentRecord"("principalId");

-- CreateIndex
CREATE INDEX "WithdrawalIntentRecord_state_idx" ON "WithdrawalIntentRecord"("state");

-- CreateIndex
CREATE INDEX "WithdrawalIntentRecord_txHash_idx" ON "WithdrawalIntentRecord"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalIntentRecord_assetId_principalId_nonce_key" ON "WithdrawalIntentRecord"("assetId", "principalId", "nonce");

-- CreateIndex
CREATE INDEX "FinancialIncident_status_createdAt_idx" ON "FinancialIncident"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialIncident_assetId_idx" ON "FinancialIncident"("assetId");

-- CreateIndex
CREATE INDEX "FinancialIncident_kind_idx" ON "FinancialIncident"("kind");

-- CreateIndex
CREATE INDEX "TreasuryReconciliation_assetId_createdAt_idx" ON "TreasuryReconciliation"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "TreasuryReconciliation_status_idx" ON "TreasuryReconciliation"("status");

-- CreateIndex
CREATE INDEX "GameEvent_tableId_occurredAt_idx" ON "GameEvent"("tableId", "occurredAt");

-- CreateIndex
CREATE INDEX "GameEvent_type_idx" ON "GameEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "GameEvent_tableId_eventSeq_key" ON "GameEvent"("tableId", "eventSeq");

-- CreateIndex
CREATE INDEX "GameActionRequest_tableId_principalId_idx" ON "GameActionRequest"("tableId", "principalId");

-- CreateIndex
CREATE INDEX "GameActionRequest_tableId_turnId_idx" ON "GameActionRequest"("tableId", "turnId");

-- CreateIndex
CREATE INDEX "GameActionRequest_status_idx" ON "GameActionRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GameActionRequest_tableId_requestId_key" ON "GameActionRequest"("tableId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "GameOutbox_dedupeKey_key" ON "GameOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "GameOutbox_status_availableAt_idx" ON "GameOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "GameOutbox_tableId_status_idx" ON "GameOutbox"("tableId", "status");

-- CreateIndex
CREATE INDEX "TournamentEvent_tournamentId_occurredAt_idx" ON "TournamentEvent"("tournamentId", "occurredAt");

-- CreateIndex
CREATE INDEX "TournamentEvent_type_idx" ON "TournamentEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEvent_tournamentId_eventSeq_key" ON "TournamentEvent"("tournamentId", "eventSeq");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEvent_tournamentId_stateFingerprint_key" ON "TournamentEvent"("tournamentId", "stateFingerprint");

-- CreateIndex
CREATE INDEX "ChipAccount_principalId_idx" ON "ChipAccount"("principalId");

-- CreateIndex
CREATE INDEX "ChipAccount_kind_scopeKey_idx" ON "ChipAccount"("kind", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChipAccount_principalId_kind_scopeKey_key" ON "ChipAccount"("principalId", "kind", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChipLedgerEntry_idempotencyKey_key" ON "ChipLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChipLedgerEntry_accountId_createdAt_idx" ON "ChipLedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ChipLedgerEntry_referenceId_idx" ON "ChipLedgerEntry"("referenceId");

-- CreateIndex
CREATE INDEX "ChipLedgerEntry_type_idx" ON "ChipLedgerEntry"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ChipGrant_idempotencyKey_key" ON "ChipGrant"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChipGrant_ledgerEntryId_key" ON "ChipGrant"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "ChipGrant_principalId_createdAt_idx" ON "ChipGrant"("principalId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomicPolicy_status_idx" ON "EconomicPolicy"("status");

-- CreateIndex
CREATE INDEX "EconomicPolicy_assetId_idx" ON "EconomicPolicy"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomicPolicy_name_version_key" ON "EconomicPolicy"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ChipAssetConversion_journalRequestId_key" ON "ChipAssetConversion"("journalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChipAssetConversion_idempotencyKey_key" ON "ChipAssetConversion"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChipAssetConversion_principalId_idx" ON "ChipAssetConversion"("principalId");

-- CreateIndex
CREATE INDEX "ChipAssetConversion_scopeType_scopeId_idx" ON "ChipAssetConversion"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "ChipAssetConversion_assetId_idx" ON "ChipAssetConversion"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ChipAssetSettlement_journalRequestId_key" ON "ChipAssetSettlement"("journalRequestId");

-- CreateIndex
CREATE INDEX "ChipAssetSettlement_assetId_idx" ON "ChipAssetSettlement"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ChipAssetSettlement_scopeType_scopeId_referenceId_key" ON "ChipAssetSettlement"("scopeType", "scopeId", "referenceId");

-- CreateIndex
CREATE INDEX "CustodyHeartbeat_chainId_signerAddress_observedAt_idx" ON "CustodyHeartbeat"("chainId", "signerAddress", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyHeartbeat_chainId_signerAddress_workerId_key" ON "CustodyHeartbeat"("chainId", "signerAddress", "workerId");

-- AddForeignKey
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_economicPolicyId_fkey" FOREIGN KEY ("economicPolicyId") REFERENCES "EconomicPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_economicPolicyId_fkey" FOREIGN KEY ("economicPolicyId") REFERENCES "EconomicPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_currentTableId_fkey" FOREIGN KEY ("currentTableId") REFERENCES "Table"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandHistory" ADD CONSTRAINT "HandHistory_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerNote" ADD CONSTRAINT "PlayerNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerNote" ADD CONSTRAINT "PlayerNote_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtomicAccount" ADD CONSTRAINT "AtomicAccount_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalTransaction" ADD CONSTRAINT "JournalTransaction_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_transactionId_assetId_fkey" FOREIGN KEY ("transactionId", "assetId") REFERENCES "JournalTransaction"("id", "assetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalPosting" ADD CONSTRAINT "JournalPosting_accountId_assetId_fkey" FOREIGN KEY ("accountId", "assetId") REFERENCES "AtomicAccount"("id", "assetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositClaimRecord" ADD CONSTRAINT "DepositClaimRecord_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalIntentRecord" ADD CONSTRAINT "WithdrawalIntentRecord_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryReconciliation" ADD CONSTRAINT "TreasuryReconciliation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameActionRequest" ADD CONSTRAINT "GameActionRequest_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameOutbox" ADD CONSTRAINT "GameOutbox_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEvent" ADD CONSTRAINT "TournamentEvent_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChipLedgerEntry" ADD CONSTRAINT "ChipLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChipAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChipAssetConversion" ADD CONSTRAINT "ChipAssetConversion_economicPolicyId_fkey" FOREIGN KEY ("economicPolicyId") REFERENCES "EconomicPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChipAssetSettlement" ADD CONSTRAINT "ChipAssetSettlement_economicPolicyId_fkey" FOREIGN KEY ("economicPolicyId") REFERENCES "EconomicPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

