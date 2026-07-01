import { PrismaClient } from "../../../api/generated/prisma/index.js";
import { BlockchainService } from "./blockchain-service.js";
import { config } from "../config.js";
import type { Logger } from "pino";

export class TransactionMonitor {
  constructor(
    private prisma: PrismaClient,
    private chainService: BlockchainService,
    private logger: Logger
  ) {}

  start() {
    this.logger.info("📡 Transaction Monitor Started");
    void this.monitorLoop().catch((e) => this.logger.error(e, "Transaction Monitor Loop Failed"));
  }

  private async monitorLoop() {
    while (true) {
      await this.monitor();
      await new Promise((resolve) => setTimeout(resolve, config.TRANSACTION_MONITOR_INTERVAL_MS));
    }
  }

  private async monitor() {
    const pendingTxs = await this.prisma.paymentTransaction.findMany({
      where: { status: "PROCESSING" },
    });

    for (const tx of pendingTxs) {
      try {
        const chain = await this.prisma.blockchain.findUnique({
          where: { id: tx.blockchainId },
        });

        if (!chain || !tx.txHash) continue;

        const client = this.chainService.getPublicClient(chain);
        const receipt = await client.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });

        if (receipt.status === "success") {
          await this.prisma.paymentTransaction.update({
            where: { id: tx.id },
            data: {
              status: "CONFIRMED",
              confirmedAt: new Date(),
            },
          });
          this.logger.info(`Tx Confirmed: ${tx.txHash}`);
        } else {
          // Transaction reverted: refund from PENDING_WITHDRAWAL back to MAIN
          await this.prisma.$transaction(async (db) => {
            const currentTx = await db.paymentTransaction.findUnique({
              where: { id: tx.id },
            });
            if (!currentTx || currentTx.status === "FAILED") return;

            const userId = currentTx.userId;
            const refundAmount = currentTx.amountCredit;

            // Debit PENDING_WITHDRAWAL account (release held funds)
            const pendingAccount = await db.account.findUnique({
              where: {
                userId_currency_type: {
                  userId,
                  currency: config.DEFAULT_CURRENCY,
                  type: "PENDING_WITHDRAWAL",
                },
              },
            });

            if (pendingAccount && pendingAccount.balance >= refundAmount) {
              await db.account.update({
                where: { id: pendingAccount.id },
                data: { balance: { decrement: refundAmount } },
              });
            }

            // Credit MAIN account (return funds to available balance)
            const mainAccount = await db.account.findUniqueOrThrow({
              where: {
                userId_currency_type: {
                  userId,
                  currency: config.DEFAULT_CURRENCY,
                  type: "MAIN",
                },
              },
            });

            await db.account.update({
              where: { id: mainAccount.id },
              data: { balance: { increment: refundAmount } },
            });

            // Create REFUND ledger entries: credit MAIN, debit PENDING_WITHDRAWAL
            await db.ledgerEntry.createMany({
              data: [
                {
                  accountId: mainAccount.id,
                  amount: refundAmount,
                  type: "REFUND",
                  referenceId: currentTx.id,
                  metadata: {
                    reason: "Withdrawal transaction reverted on chain",
                    txHash: tx.txHash,
                  },
                },
                ...(pendingAccount
                  ? [
                      {
                        accountId: pendingAccount.id,
                        amount: -refundAmount,
                        type: "REFUND" as const,
                        referenceId: currentTx.id,
                        metadata: {
                          reason: "PENDING_WITHDRAWAL release: withdrawal reverted on chain",
                          txHash: tx.txHash,
                        },
                      },
                    ]
                  : []),
              ],
            });

            await db.paymentTransaction.update({
              where: { id: tx.id },
              data: { status: "FAILED", confirmedAt: new Date() },
            });
          });
          this.logger.error(`Tx Reverted: ${tx.txHash}`);
        }
      } catch (_error) {
        // Transaction still pending; will be re-checked on next poll
      }
    }
  }
}
