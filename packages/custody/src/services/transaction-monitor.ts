import { PrismaClient } from "../../../api/generated/prisma/index.js";
import { BlockchainService } from "./blockchain-service.js";
import { config } from "../config.js";
import type { Logger } from "pino";

import { refundBroadcastWithdrawal } from "./refund-broadcast-withdrawal.js";

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
      try {
        await this.monitor();
      } catch (error) {
        this.logger.error({ error }, "Transaction scan failed; will retry");
      }
      await new Promise((resolve) => setTimeout(resolve, config.TRANSACTION_MONITOR_INTERVAL_MS));
    }
  }

  private async monitor() {
    const pendingTxs = await this.prisma.paymentTransaction.findMany({
      where: { type: "WITHDRAWAL", status: "PROCESSING" },
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
          await this.prisma.paymentTransaction.updateMany({
            where: { id: tx.id, status: "PROCESSING" },
            data: {
              status: "CONFIRMED",
              confirmedAt: new Date(),
            },
          });
          this.logger.info(`Tx Confirmed: ${tx.txHash}`);
        } else {
          await refundBroadcastWithdrawal(
            this.prisma,
            tx.id,
            config.DEFAULT_CURRENCY,
            "Withdrawal transaction reverted on chain"
          );
          this.logger.error(`Tx Reverted: ${tx.txHash}`);
        }
      } catch (error) {
        // Missing receipts are expected while a transaction is still pending.
        if (!(error instanceof Error) || error.name !== "TransactionReceiptNotFoundError") {
          this.logger.error({ paymentId: tx.id, error }, "Transaction monitor failed; will retry");
        }
      }
    }
  }
}
