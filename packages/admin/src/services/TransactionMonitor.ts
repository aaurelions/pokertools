import { PrismaClient } from "../../../api/generated/prisma/index.js";
import { BlockchainService } from "./BlockchainService.js";
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
      await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
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
          await this.prisma.paymentTransaction.update({
            where: { id: tx.id },
            data: { status: "FAILED" },
          });
          this.logger.error(`Tx Reverted: ${tx.txHash}`);
        }
      } catch (_error) {
        // Ignored: Tx likely still pending
      }
    }
  }
}
