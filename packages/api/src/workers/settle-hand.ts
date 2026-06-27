import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import crypto from "node:crypto";
import { config } from "../config.js";
import { getHouseUserId } from "../utils/house-user.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
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
    const rakeAmount = Number(rakeTotal);

    const lockKey = `lock:table:${tableId}`;
    const lockToken = crypto.randomUUID();
    const lockAcquired = await redis.set(lockKey, lockToken, "PX", 5000, "NX");
    if (!lockAcquired) {
      throw new Error(`Unable to acquire settlement lock for table ${tableId}`);
    }

    try {
      await prisma.$transaction(async (tx: any) => {
        const existingSettlement = await tx.ledgerEntry.findFirst({
          where: { referenceId: handId, type: { in: ["HAND_WIN", "HAND_LOSS", "RAKE"] } },
        });
        if (existingSettlement) return;

        if (rakeAmount > 0) {
          const houseUserId = await getHouseUserId(prisma);
          const houseAccount = await tx.account.findUniqueOrThrow({
            where: {
              userId_currency_type: {
                userId: houseUserId,
                currency: "USDC",
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
          const netChange = Number(netChangeStr);
          if (netChange === 0) continue;

          const account = await tx.account.findUniqueOrThrow({
            where: {
              userId_currency_type: { userId, currency: "USDC", type: "IN_PLAY" },
            },
          });

          const newBalance = Number(account.balance) + netChange;
          if (newBalance < 0) {
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
              type: netChange > 0 ? "HAND_WIN" : "HAND_LOSS",
              referenceId: handId,
              metadata: { tableId },
            },
          });

          if (netChange > 0) {
            await tx.account.update({
              where: { id: account.id },
              data: { balance: { increment: netChange } },
            });
          } else {
            await tx.account.update({
              where: { id: account.id },
              data: { balance: { decrement: Math.abs(netChange) } },
            });
          }
        }
      });
    } finally {
      const unlockScript =
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
      await redis.eval(unlockScript, 1, lockKey, lockToken);
    }

    logger.info({ handId, rakeTotal }, "Hand settled");
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "settle-hand job failed");
});

export default worker;
