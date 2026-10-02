import { Worker } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import pino from "pino";
import { config } from "../config.js";
import { getHouseUserId } from "../utils/house-user.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { FinancialManager } from "../services/financial-manager.js";

const prisma = createPrismaClient();
const financialManager = new FinancialManager(prisma);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as unknown as Redlock.CompatibleRedisClient], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: 0,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
});
const logger = pino({ name: "settle-hand" });

/**
 * Hand Settlement Worker
 *
 * Syncs engine state with the chip economy after each hand. Player net changes
 * are applied to their table reserve chip accounts and rake is credited to the
 * house operator chip account. No legacy cents/Account/LedgerEntry rows are
 * touched. Settlement is idempotent on `handId`: a repeated job is a no-op.
 */
const worker = new Worker(
  "settle-hand",
  async (job) => {
    const { tableId, handId, playerNetChanges, rakeTotal } = job.data;

    const lockKey = `lock:table:${tableId}`;
    let lock;
    try {
      lock = await redlock.lock([lockKey], config.SETTLE_HAND_LOCK_TTL_MS);
    } catch {
      throw new Error(`Unable to acquire settlement lock for table ${tableId}`);
    }

    try {
      const houseUserId = await getHouseUserId(prisma);
      const result = await financialManager.settleHand({
        tableId,
        handId,
        playerNetChanges: playerNetChanges as Record<string, string>,
        rakeTotal,
        houseUserId,
      });
      if (result.replayed) {
        logger.info({ handId }, "Hand settlement already applied (no-op)");
        return;
      }
    } finally {
      await lock.unlock().catch(() => undefined);
    }

    logger.info({ handId, rakeTotal }, "Hand settled");
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "settle-hand job failed");
});

export default worker;
