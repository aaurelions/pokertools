-- Identity principals: add User.kind, make User.address nullable for SERVICE
-- identities, retire the BOT role, and introduce scoped/revocable service
-- credentials. SQLite requires a table rebuild to relax NOT NULL and to change
-- the role constraint, so User is recreated and copied with BOT -> PLAYER.
--
-- NOTE: the operator must register the PostgreSQL counterpart in
-- prisma/postgres/migrations.json (this contribution intentionally does not).

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "address" TEXT,
    "role" TEXT NOT NULL DEFAULT 'PLAYER',
    "kind" TEXT NOT NULL DEFAULT 'WALLET',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_User" ("id", "username", "address", "role", "kind", "createdAt", "updatedAt")
SELECT
    "id",
    "username",
    "address",
    CASE WHEN "role" = 'BOT' THEN 'PLAYER' ELSE "role" END,
    'WALLET',
    "createdAt",
    "updatedAt"
FROM "User";

DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";

CREATE INDEX IF NOT EXISTS "User_address_idx" ON "User"("address");
CREATE UNIQUE INDEX IF NOT EXISTS "User_address_key" ON "User"("address");
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE INDEX IF NOT EXISTS "User_kind_idx" ON "User"("kind");

CREATE TABLE IF NOT EXISTS "ServiceCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "tableId" TEXT,
    "seat" INTEGER,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceCredential_userId_key" ON "ServiceCredential"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceCredential_keyHash_key" ON "ServiceCredential"("keyHash");
CREATE INDEX IF NOT EXISTS "ServiceCredential_userId_idx" ON "ServiceCredential"("userId");
CREATE INDEX IF NOT EXISTS "ServiceCredential_createdById_idx" ON "ServiceCredential"("createdById");
CREATE INDEX IF NOT EXISTS "ServiceCredential_revoked_idx" ON "ServiceCredential"("revoked");
CREATE INDEX IF NOT EXISTS "ServiceCredential_tableId_idx" ON "ServiceCredential"("tableId");

PRAGMA foreign_keys=ON;
