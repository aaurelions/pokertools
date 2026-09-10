import type { PrismaClient } from "../../../api/generated/prisma/index.js";

/** Refund a reverted broadcast exactly once, reversing its recorded reserve credit. */
export async function refundBroadcastWithdrawal(
  prisma: PrismaClient,
  paymentId: string,
  currency: string,
  reason: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.paymentTransaction.findUnique({ where: { id: paymentId } });
    if (payment?.type !== "WITHDRAWAL" || payment.status !== "PROCESSING") return false;
    if (!payment.txHash || !payment.ledgerEntryId)
      throw new Error("Missing withdrawal broadcast reference");

    // Competing monitors cannot both claim the same refund. Later errors roll back this claim.
    const claimed = await tx.paymentTransaction.updateMany({
      where: { id: paymentId, status: "PROCESSING" },
      data: { status: "FAILED", recoveryState: "RECOVERY_REFUNDED", confirmedAt: new Date() },
    });
    if (claimed.count !== 1) return false;

    const entries = await tx.ledgerEntry.findMany({
      where: { referenceId: payment.ledgerEntryId, type: "WITHDRAWAL" },
    });
    const credits = entries.filter((entry) => {
      const metadata = entry.metadata as { stage?: string } | null;
      return metadata?.stage === "broadcast-complete" && entry.amount > 0n;
    });
    if (credits.reduce((sum, entry) => sum + entry.amount, 0n) !== payment.amountCredit) {
      throw new Error("Withdrawal broadcast reserve entries do not match refund amount");
    }

    const main = await tx.account.findUniqueOrThrow({
      where: { userId_currency_type: { userId: payment.userId, currency, type: "MAIN" } },
    });
    for (const entry of credits) {
      const debited = await tx.account.updateMany({
        where: {
          id: entry.accountId,
          type: "HOUSE_RESERVE",
          currency,
          balance: { gte: entry.amount },
        },
        data: { balance: { decrement: entry.amount } },
      });
      if (debited.count !== 1)
        throw new Error("Insufficient recorded broadcast reserve for refund");
    }
    await tx.account.update({
      where: { id: main.id },
      data: { balance: { increment: payment.amountCredit } },
    });
    await tx.ledgerEntry.createMany({
      data: [
        {
          accountId: main.id,
          amount: payment.amountCredit,
          type: "REFUND",
          referenceId: paymentId,
          metadata: { reason },
        },
        ...credits.map((entry) => ({
          accountId: entry.accountId,
          amount: -entry.amount,
          type: "REFUND" as const,
          referenceId: paymentId,
          metadata: { reason, reversedEntryId: entry.id },
        })),
      ],
    });
    return true;
  });
}
