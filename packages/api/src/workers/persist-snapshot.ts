import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { persistSnapshotProjection } from "../services/snapshot-projection.js";

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

    await persistSnapshotProjection(prisma, tableId, snapshot);

    console.log(`💾 Persisted snapshot for table ${tableId} to database`);
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  console.error(`❌ persist-snapshot job ${job?.id} failed:`, err);
});

export default worker;
