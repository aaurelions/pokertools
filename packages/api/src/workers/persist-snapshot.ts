import { Worker } from "bullmq";
import { PrismaClient } from "../../generated/prisma/index.js";
import { Redis } from "ioredis";
import { config } from "../config.js";

const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);

/**
 * Persist Snapshot Worker
 *
 * Syncs Redis game state to PostgreSQL/SQLite for crash recovery.
 * This is the "write-behind" persistence pattern.
 */
const worker = new Worker(
  "persist-snapshot",
  async (job) => {
    const { tableId, snapshot } = job.data;

    // Save state to database (Prisma handles JSON serialization)
    await prisma.table.update({
      where: { id: tableId },
      data: {
        state: snapshot,
        status: snapshot.phase === "WAITING" ? "WAITING" : "ACTIVE",
        updatedAt: new Date(),
      },
    });

    console.log(`💾 Persisted snapshot for table ${tableId} to database`);
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ persist-snapshot job ${job?.id} failed:`, err);
});

export default worker;
