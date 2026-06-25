import { Worker } from "bullmq";
import { PokerEngine } from "@pokertools/engine";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prismaClient.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Archive Hand Worker
 *
 * Uses Engine's native export functionality to archive hand history.
 */
const worker = new Worker(
  "archive-hand",
  async (job) => {
    const { tableId, handId, snapshot } = job.data;

    // Restore engine to export formatted history
    const engine = PokerEngine.restore(snapshot);
    const historyData = engine.history({ format: "json" });

    await prisma.handHistory.create({
      data: {
        tableId,
        data: historyData,
        timestamp: new Date(),
      },
    });

    console.log(`✅ Archived hand ${handId} for table ${tableId}`);
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  console.error(`❌ archive-hand job ${job?.id} failed:`, err);
});

export default worker;
