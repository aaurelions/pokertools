import { Worker } from "bullmq";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PokerEngine } from "@pokertools/engine";
import { Redis } from "ioredis";
import { config } from "../config.js";

const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);

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
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ archive-hand job ${job?.id} failed:`, err);
});

export default worker;
