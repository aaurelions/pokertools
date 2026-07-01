import { Worker } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import pino from "pino";
import { config } from "../config.js";
import { getHouseUserId } from "../utils/house-user.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as any], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: 0,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
});
const logger = pino({ name: "settle-hand" });

/**
 * Hand Settlement Worker
 *
 * Syncs engine state with the financial ledger after each hand.
 * Credits House account with rake.
 */
const worker = new Worker(
  "settle-hand",
  async (job) => {
    const { tableId, handId, playerNetChanges, rakeTotal } = job.data;
    const rakeAmount = BigInt(rakeTotal);

    const lockKey = `lock:table:${tableId}`;
    let lock;
    try {
      lock = await redlock.acquire([lockKey], config.SETTLE_HAND_LOCK_TTL_MS);
    } catch {
      throw new Error(`Unable to acquire settlement lock for table ${tableId}`);
    }

    try {
      await prisma.$transaction(async (tx: any) => {
        const existingSettlement = await tx.ledgerEntry.findFirst({
          where: { referenceId: handId, type: { in: ["HAND_WIN", "HAND_LOSS", "RAKE"] } },
        });
        if (existingSettlement) return;

        if (rakeAmount > 0n) {
          const houseUserId = await getHouseUserId(prisma);
          const houseAccount = await tx.account.findUniqueOrThrow({
            where: {
              userId_currency_type: {
                userId: houseUserId,
                currency: config.DEFAULT_CURRENCY,
                type: "MAIN",
              },
            },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: houseAccount.id,
              amount: rakeAmount,
              type: "RAKE",
              referenceId: handId,
              metadata: { tableId },
            },
          });

          await tx.account.update({
            where: { id: houseAccount.id },
            data: { balance: { increment: rakeAmount } },
          });
        }

        // Process player changes
        for (const [userId, netChangeStr] of Object.entries(playerNetChanges)) {
          const netChange = BigInt(netChangeStr as string);
          if (netChange === 0n) continue;

          const account = await tx.account.findUniqueOrThrow({
            where: {
              userId_currency_type: { userId, currency: config.DEFAULT_CURRENCY, type: "IN_PLAY" },
            },
          });

          const newBalance = BigInt(account.balance) + netChange;
          if (newBalance < 0n) {
            throw new Error(
              `Settlement would make IN_PLAY negative for user ${userId}: ${newBalance}`
            );
          }

          // Always create ledger entry for audit trail in the same transaction as
          // the corresponding balance update.
          await tx.ledgerEntry.create({
            data: {
              accountId: account.id,
              amount: netChange,
              type: netChange > 0n ? "HAND_WIN" : "HAND_LOSS",
              referenceId: handId,
              metadata: { tableId },
            },
          });

          if (netChange > 0n) {
            await tx.account.update({
              where: { id: account.id },
              data: { balance: { increment: netChange } },
            });
          } else {
            await tx.account.update({
              where: { id: account.id },
              data: { balance: { decrement: -netChange } },
            });
          }
        }
      });
    } finally {
      await lock.release().catch(() => undefined);
    }

    logger.info({ handId, rakeTotal }, "Hand settled");
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "settle-hand job failed");
});

export default worker;
