/**
 * BullMQ Workers
 *
 * This file imports and initializes all workers.
 * Workers run in the background to process async jobs.
 */

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { config } from "../config.js";
import settleHandWorker from "./settle-hand.js";
import archiveHandWorker from "./archive-hand.js";
import nextHandWorker from "./next-hand.js";
import persistSnapshotWorker from "./persist-snapshot.js";
import timeoutWorker from "./timeout.js";
import createDepositMonitorWorker from "./deposit-monitor.js";
import createTournamentBlindsWorker from "./tournament-blinds.js";

// Initialize deposit monitor worker (standalone mode)
const depositMonitorWorker = await createDepositMonitorWorker();

// Initialize tournament blinds worker (standalone mode)
const tournamentBlindsWorker = await createTournamentBlindsWorker();

const logger = pino({ name: "workers" });
logger.info(
  {
    workers: [
      "settle-hand",
      "archive-hand",
      "next-hand",
      "persist-snapshot",
      "player-timeout",
      "deposit-monitor",
      "tournament-blinds",
    ],
  },
  "BullMQ Workers initialized"
);

// Export workers for cleanup on shutdown
export const workers = [
  settleHandWorker,
  archiveHandWorker,
  nextHandWorker,
  persistSnapshotWorker,
  timeoutWorker,
  depositMonitorWorker,
  tournamentBlindsWorker,
];

// ============================================================================
// Schedule Deposit Monitor as Repeatable Job
// ============================================================================

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

(async () => {
  try {
    // Schedule deposit monitor as a repeatable job (every 15 seconds)
    const depositQueue = new Queue("deposit-monitor", { connection: redis as any });
    await depositQueue.add(
      "deposit-monitor",
      {},
      {
        repeat: { every: 15000 },
        jobId: "deposit-monitor-singleton",
      }
    );
    logger.info("Deposit monitor scheduled: every 15 seconds");

    // Schedule tournament blinds as a repeatable job
    const blindsQueue = new Queue("tournament-blinds", { connection: redis as any });
    await blindsQueue.add(
      "tournament-blinds",
      {},
      {
        repeat: { every: config.TOURNAMENT_BLIND_SCAN_INTERVAL_MS },
        jobId: "tournament-blinds-singleton",
      }
    );
    logger.info(`Tournament blinds scheduler: every ${config.TOURNAMENT_BLIND_SCAN_INTERVAL_MS}ms`);
  } catch (error) {
    logger.error({ error }, "Failed to schedule repeatable jobs");
  }
})();

process.on("SIGTERM", async () => {
  logger.info("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
