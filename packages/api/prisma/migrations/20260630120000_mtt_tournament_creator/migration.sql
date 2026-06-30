-- Track the required creator/manager of a tournament lobby.
ALTER TABLE "Tournament" ADD COLUMN "creatorId" TEXT NOT NULL;

CREATE INDEX "Tournament_creatorId_idx" ON "Tournament"("creatorId");
