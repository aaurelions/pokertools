-- Initial PokerTools schema for the latest production line.
-- Backward compatibility with pre-1.0.16 databases is intentionally not kept;
-- deploy fresh databases from this migration or restore via an explicit data migration.

PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "type" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "AdminWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "xpub" TEXT NOT NULL,
    "xpriv" TEXT NOT NULL,
    "derivationPath" TEXT NOT NULL DEFAULT 'm/44''/60''/0''/0',
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Blockchain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "rpcUrl" TEXT NOT NULL,
    "rpcUrlBackup" TEXT,
    "explorerUrl" TEXT NOT NULL,
    "nativeCurrency" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "confirmations" INTEGER NOT NULL DEFAULT 12,
    "lastScannedBlock" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "DepositSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "userWalletId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DepositSession_userWalletId_fkey" FOREIGN KEY ("userWalletId") REFERENCES "UserWallet" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "HandHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HandHistory_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "response" JSONB,
    "statusCode" INTEGER,
    "errorCode" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PaymentTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "blockchainId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "txHash" TEXT,
    "address" TEXT NOT NULL,
    "blockNumber" TEXT,
    "blockHash" TEXT,
    "amountRaw" TEXT NOT NULL,
    "amountCredit" INTEGER NOT NULL,
    "fee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "recoveryState" TEXT,
    "idempotencyKey" TEXT,
    "ledgerEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    CONSTRAINT "PaymentTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransaction_blockchainId_fkey" FOREIGN KEY ("blockchainId") REFERENCES "Blockchain" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransaction_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentTransaction_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PlayerNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlayerNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayerNote_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Table" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "config" JSONB NOT NULL,
    "state" JSONB,
    "tournamentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Table_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blockchainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "minDeposit" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Token_blockchainId_fkey" FOREIGN KEY ("blockchainId") REFERENCES "Blockchain" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Tournament" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTRATION',
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
    "startsAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tournament_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Tournament_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "TournamentEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "placement" INTEGER,
    "prize" INTEGER NOT NULL DEFAULT 0,
    "currentTableId" TEXT,
    "currentSeat" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TournamentEntry_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TournamentEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TournamentEntry_currentTableId_fkey" FOREIGN KEY ("currentTableId") REFERENCES "Table" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PLAYER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "UserWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "adminWalletId" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    CONSTRAINT "UserWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserWallet_adminWalletId_fkey" FOREIGN KEY ("adminWalletId") REFERENCES "AdminWallet" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Account_userId_currency_type_key" ON "Account"("userId", "currency", "type");
CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_resource_idx" ON "AuditLog"("resource");
CREATE UNIQUE INDEX IF NOT EXISTS "Blockchain_chainId_key" ON "Blockchain"("chainId");
CREATE UNIQUE INDEX IF NOT EXISTS "Blockchain_name_key" ON "Blockchain"("name");
CREATE INDEX IF NOT EXISTS "DepositSession_expiresAt_idx" ON "DepositSession"("expiresAt");
CREATE INDEX IF NOT EXISTS "HandHistory_tableId_timestamp_idx" ON "HandHistory"("tableId", "timestamp");
CREATE INDEX IF NOT EXISTS "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");
CREATE INDEX IF NOT EXISTS "IdempotencyRecord_userId_scope_idx" ON "IdempotencyRecord"("userId", "scope");
CREATE INDEX IF NOT EXISTS "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");
CREATE INDEX IF NOT EXISTS "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");
CREATE INDEX IF NOT EXISTS "LedgerEntry_referenceId_idx" ON "LedgerEntry"("referenceId");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_blockHash_idx" ON "PaymentTransaction"("blockHash");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_blockchainId_txHash_key" ON "PaymentTransaction"("blockchainId", "txHash");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_idempotencyKey_key" ON "PaymentTransaction"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_ledgerEntryId_key" ON "PaymentTransaction"("ledgerEntryId");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_recoveryState_idx" ON "PaymentTransaction"("recoveryState");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_userId_type_idx" ON "PaymentTransaction"("userId", "type");
CREATE INDEX IF NOT EXISTS "PlayerNote_authorId_idx" ON "PlayerNote"("authorId");
CREATE UNIQUE INDEX IF NOT EXISTS "PlayerNote_authorId_targetId_key" ON "PlayerNote"("authorId", "targetId");
CREATE INDEX IF NOT EXISTS "Session_jti_idx" ON "Session"("jti");
CREATE UNIQUE INDEX IF NOT EXISTS "Session_jti_key" ON "Session"("jti");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "Table_status_idx" ON "Table"("status");
CREATE INDEX IF NOT EXISTS "Table_tournamentId_idx" ON "Table"("tournamentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Token_blockchainId_address_key" ON "Token"("blockchainId", "address");
CREATE INDEX IF NOT EXISTS "TournamentEntry_currentTableId_idx" ON "TournamentEntry"("currentTableId");
CREATE UNIQUE INDEX IF NOT EXISTS "TournamentEntry_tournamentId_seat_key" ON "TournamentEntry"("tournamentId", "seat");
CREATE UNIQUE INDEX IF NOT EXISTS "TournamentEntry_tournamentId_userId_key" ON "TournamentEntry"("tournamentId", "userId");
CREATE INDEX IF NOT EXISTS "TournamentEntry_userId_status_idx" ON "TournamentEntry"("userId", "status");
CREATE INDEX IF NOT EXISTS "Tournament_creatorId_idx" ON "Tournament"("creatorId");
CREATE INDEX IF NOT EXISTS "Tournament_status_createdAt_idx" ON "Tournament"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Tournament_tableId_key" ON "Tournament"("tableId");
CREATE INDEX IF NOT EXISTS "UserWallet_address_idx" ON "UserWallet"("address");
CREATE UNIQUE INDEX IF NOT EXISTS "UserWallet_userId_adminWalletId_key" ON "UserWallet"("userId", "adminWalletId");
CREATE INDEX IF NOT EXISTS "User_address_idx" ON "User"("address");
CREATE UNIQUE INDEX IF NOT EXISTS "User_address_key" ON "User"("address");
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
