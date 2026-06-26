import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

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
        state: JSON.stringify(snapshot),
        status: "ACTIVE",
        updatedAt: new Date(),
      },
    });

    console.log(`💾 Persisted snapshot for table ${tableId} to database`);
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  console.error(`❌ persist-snapshot job ${job?.id} failed:`, err);
});

export default worker;
