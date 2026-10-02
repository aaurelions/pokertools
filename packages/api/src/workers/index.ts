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
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { dispatchPendingOutbox, requeueFailedOutbox } from "../services/game-outbox.js";
import { bootstrapCanonicalDepositMonitor } from "./canonical-deposit-monitor.js";
import settleHandWorker from "./settle-hand.js";
import archiveHandWorker from "./archive-hand.js";
import nextHandWorker from "./next-hand.js";
import persistSnapshotWorker from "./persist-snapshot.js";
import timeoutWorker from "./timeout.js";
import createTournamentBlindsWorker from "./tournament-blinds.js";
import reconciliationWorker from "./reconciliation.js";

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
  tournamentBlindsWorker,
  reconciliationWorker,
];

// ============================================================================
// Schedule Deposit Monitor as Repeatable Job
// ============================================================================

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// ============================================================================
// Durable game outbox recovery
//
// Side-effect intents were committed with their game mutation. Dispatch is
// best-effort; a crash or Redis outage leaves PENDING/FAILED rows that this
// sweep re-drives. Recovery reads PostgreSQL only and never requires Redis to
// have been available at commit time.
// ============================================================================

const outboxPrisma = createPrismaClient();
const outboxQueues = createJobQueues(redis);
const OUTBOX_SWEEP_INTERVAL_MS = config.GAME_OUTBOX_SWEEP_INTERVAL_MS;

async function recoverGameOutbox(): Promise<void> {
  try {
    await requeueFailedOutbox(outboxPrisma);
    const result = await dispatchPendingOutbox(outboxPrisma, outboxQueues, redis);
    if (result.dispatched > 0 || result.failed > 0) {
      logger.info(result, "Recovered game outbox intents");
    }
  } catch (error) {
    logger.error({ error }, "Game outbox recovery failed");
  }
}

void recoverGameOutbox();
const outboxSweep = setInterval(() => void recoverGameOutbox(), OUTBOX_SWEEP_INTERVAL_MS);

// ============================================================================
// Canonical direct-treasury deposit monitor
//
// Settlement-critical settlement reads require validated RPC quorum. A
// transient RPC outage at boot must not crash the process, but the monitor must
// not silently stay off either: bootstrap retries until the validated registry
// starts. Deposit claims still fail closed through the per-claim verifier while
// the monitor is unavailable.
// ============================================================================

const depositMonitorLogger = logger.child({ worker: "canonical-deposit-monitor" });
let depositMonitorWorker: { close: () => Promise<void> } | null = null;

async function startCanonicalDepositMonitor(): Promise<void> {
  if (depositMonitorWorker) return;
  try {
    const monitor = await bootstrapCanonicalDepositMonitor({
      prisma: outboxPrisma,
      redis,
      logger: depositMonitorLogger,
      intervalMs: config.CANONICAL_DEPOSIT_MONITOR_INTERVAL_MS,
    });
    depositMonitorWorker = monitor.worker;
    logger.info("Canonical deposit monitor started");
  } catch (error) {
    depositMonitorLogger.warn({ error }, "Canonical deposit monitor unavailable; will retry");
    setTimeout(() => void startCanonicalDepositMonitor(), OUTBOX_SWEEP_INTERVAL_MS);
  }
}

void startCanonicalDepositMonitor();

(async () => {
  try {
    // BullMQ 6: repeatable jobs are Job Schedulers. Upsert is idempotent, so
    // restarting the workers re-creates or updates the same schedulers.

    // Schedule tournament blinds as a repeatable job
    const blindsQueue = new Queue("tournament-blinds", { connection: redis });
    await blindsQueue.upsertJobScheduler(
      "tournament-blinds-singleton",
      { every: config.TOURNAMENT_BLIND_SCAN_INTERVAL_MS },
      { name: "tournament-blinds", data: {} }
    );
    logger.info(`Tournament blinds scheduler: every ${config.TOURNAMENT_BLIND_SCAN_INTERVAL_MS}ms`);

    const reconciliationQueue = new Queue("reconciliation", { connection: redis });
    await reconciliationQueue.upsertJobScheduler(
      "reconciliation-singleton",
      { every: config.RECONCILIATION_INTERVAL_MS },
      { name: "reconciliation", data: {} }
    );
    logger.info(`Reconciliation scheduler: every ${config.RECONCILIATION_INTERVAL_MS}ms`);
  } catch (error) {
    logger.error({ error }, "Failed to schedule repeatable jobs");
  }
})();

process.on("SIGTERM", async () => {
  logger.info("Shutting down workers...");
  clearInterval(outboxSweep);
  await depositMonitorWorker?.close().catch(() => undefined);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
