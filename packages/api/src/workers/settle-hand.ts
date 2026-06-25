import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { config } from "../config.js";
import { getHouseUserId } from "../utils/houseUser.js";
import { createPrismaClient } from "../utils/prismaClient.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL);
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

    await prisma.$transaction(async (tx: any) => {
      // 1. Credit House (Rake)
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

      // 2. Process player changes
      for (const [userId, netChangeStr] of Object.entries(playerNetChanges)) {
        const netChange = Number(netChangeStr);
        if (netChange === 0) continue;

        const account = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: { userId, currency: "USDC", type: "IN_PLAY" },
          },
        });

        // Always create ledger entry for audit trail
        await tx.ledgerEntry.create({
          data: {
            accountId: account.id,
            amount: netChange,
            type: netChange > 0 ? "HAND_WIN" : "HAND_LOSS",
            referenceId: handId,
            metadata: { tableId },
          },
        });

        // CRITICAL: If player stood and cashed out, their IN_PLAY might be 0 or insufficient
        // The stand endpoint already handled the sync. Skip balance update if it would go negative.
        const newBalance = Number(account.balance) + netChange;
        if (newBalance < 0) {
          continue;
        }

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

    logger.info({ handId, rakeTotal }, "Hand settled");
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "settle-hand job failed");
});

export default worker;
