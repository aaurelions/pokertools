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
import reconciliationWorker from "./reconciliation.js";

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
      "reconciliation",
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
  reconciliationWorker,
];

// ============================================================================
// Schedule Deposit Monitor as Repeatable Job
// ============================================================================

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

(async () => {
  try {
    // Schedule deposit monitor as a repeatable job
    const depositQueue = new Queue("deposit-monitor", { connection: redis as any });
    await depositQueue.add(
      "deposit-monitor",
      {},
      {
        repeat: { every: config.DEPOSIT_MONITOR_INTERVAL_MS },
        jobId: "deposit-monitor-singleton",
      }
    );
    logger.info(`Deposit monitor scheduled: every ${config.DEPOSIT_MONITOR_INTERVAL_MS}ms`);

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

    const reconciliationQueue = new Queue("reconciliation", { connection: redis as any });
    await reconciliationQueue.add(
      "reconciliation",
      {},
      {
        repeat: { every: config.RECONCILIATION_INTERVAL_MS },
        jobId: "reconciliation-singleton",
      }
    );
    logger.info(`Reconciliation scheduler: every ${config.RECONCILIATION_INTERVAL_MS}ms`);
  } catch (error) {
    logger.error({ error }, "Failed to schedule repeatable jobs");
  }
})();

process.on("SIGTERM", async () => {
  logger.info("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
