import { PrismaClient } from "../../../api/generated/prisma/index.js";
import { Bot } from "grammy";
import { BlockchainService } from "./BlockchainService.js";
import { config } from "../config.js";
import { formatEther, parseEther } from "viem";
import type { Logger } from "pino";

export class GasMonitor {
  constructor(
    private prisma: PrismaClient,
    private chainService: BlockchainService,
    private bot: Bot,
    private logger: Logger
  ) {
    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  }

  start() {
    this.logger.info("⛽ Gas Monitor Started");
    void this.monitorLoop().catch((e) => this.logger.error(e, "Gas Monitor Loop Failed"));
  }

  private async monitorLoop() {
    while (true) {
      await this.checkBalances();
      await new Promise((resolve) => setTimeout(resolve, 30 * 60 * 1000));
    }
  }

  private async checkBalances() {
    const chains = await this.prisma.blockchain.findMany({ where: { isEnabled: true } });
    const hotWalletAddress = this.chainService.hotWalletAccount.address;
    const threshold = parseEther(config.LOW_GAS_THRESHOLD_ETH.toString());

    for (const chain of chains) {
      try {
        const client = this.chainService.getPublicClient(chain);
        const balance = await client.getBalance({ address: hotWalletAddress });

        if (balance < threshold) {
          const currency = chain.nativeCurrency as { symbol: string };
          const msg = `
🚨 <b>LOW GAS WARNING</b>

<b>Chain:</b> ${chain.name}
<b>Address:</b> <code>${hotWalletAddress}</code>
<b>Current:</b> ${formatEther(balance)} ${currency.symbol}
<b>Threshold:</b> ${config.LOW_GAS_THRESHOLD_ETH} ${currency.symbol}

<i>Please top up immediately.</i>`;

          try {
            await this.bot.api.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, {
              parse_mode: "HTML",
            });
          } catch (e) {
            this.logger.error(e, "Failed to send Telegram notification");
          }
          this.logger.warn(`Low gas on ${chain.name}: ${formatEther(balance)}`);
        }
      } catch (e) {
        this.logger.error(e, `Failed to check gas for ${chain.name}`);
      }
    }
  }
}
