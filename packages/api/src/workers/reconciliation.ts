import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const logger = pino({ name: "reconciliation" });

/**
 * Reconciliation & Cleanup Worker
 *
 * Periodic maintenance tasks:
 * 1. Account balance vs ledger sum integrity check (logs mismatches)
 * 2. Expired idempotency record cleanup
 * 3. Expired session cleanup
 */
const reconciliationWorker = new Worker(
  "reconciliation",
  async () => {
    logger.info("Reconciliation worker started");

    // -------------------------------------------------------------------------
    // 1. Clean up expired idempotency records
    // -------------------------------------------------------------------------
    try {
      const deletedRecords = await prisma.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (deletedRecords.count > 0) {
        logger.info({ count: deletedRecords.count }, "Cleaned up expired idempotency records");
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to clean up idempotency records");
    }

    // -------------------------------------------------------------------------
    // 2. Clean up expired sessions
    // -------------------------------------------------------------------------
    try {
      const deletedSessions = await prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (deletedSessions.count > 0) {
        logger.info({ count: deletedSessions.count }, "Cleaned up expired sessions");
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to clean up sessions");
    }

    // -------------------------------------------------------------------------
    // 3. Account balance vs ledger sum integrity check (sample-based)
    //    We don't check ALL accounts every run to avoid DB load; we sample
    //    accounts with recent ledger activity.
    // -------------------------------------------------------------------------
    try {
      const recentAccounts = await prisma.account.findMany({
        where: {
          entries: {
            some: {
              createdAt: {
                gte: new Date(Date.now() - config.RECONCILIATION_WINDOW_HOURS * 60 * 60 * 1000),
              },
            },
          },
        },
        select: {
          id: true,
          userId: true,
          currency: true,
          type: true,
          balance: true,
        },
        take: config.RECONCILIATION_BATCH_SIZE,
        orderBy: { id: "desc" },
      });

      let mismatches = 0;

      for (const account of recentAccounts) {
        try {
          const sumResult = await prisma.ledgerEntry.aggregate({
            where: { accountId: account.id },
            _sum: { amount: true },
          });

          const ledgerSum = sumResult._sum.amount ?? 0n;
          const cachedBalance = BigInt(account.balance);

          // Allow small tolerance for BigInt/number conversion edge cases
          if (ledgerSum !== cachedBalance) {
            mismatches++;
            logger.warn(
              {
                accountId: account.id,
                userId: account.userId,
                currency: account.currency,
                type: account.type,
                cachedBalance: cachedBalance.toString(),
                ledgerSum: ledgerSum.toString(),
                diff: (cachedBalance > ledgerSum
                  ? cachedBalance - ledgerSum
                  : ledgerSum - cachedBalance
                ).toString(),
              },
              "Balance mismatch detected: cached balance differs from ledger sum"
            );
          }
        } catch (err) {
          logger.error({ error: err, accountId: account.id }, "Failed to check account balance");
        }
      }

      if (mismatches > 0) {
        logger.warn(
          { mismatches, checked: recentAccounts.length },
          "Balance reconciliation complete"
        );
      } else {
        logger.info(
          { checked: recentAccounts.length },
          "Balance reconciliation: all checked accounts match"
        );
      }
    } catch (err) {
      logger.error({ error: err }, "Failed to perform balance reconciliation");
    }
  },
  { connection: redis as any }
);

reconciliationWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "reconciliation job failed");
});

export default reconciliationWorker;
