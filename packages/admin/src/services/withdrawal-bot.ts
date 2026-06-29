import { Bot, InlineKeyboard, Context } from "grammy";
import { PrismaClient } from "../../../api/generated/prisma/index.js";
import type { Redis } from "ioredis";
import { BlockchainService } from "./blockchain-service.js";
import { config } from "../config.js";
import type { Logger } from "pino";
import { parseAbi, verifyMessage } from "viem";
import { CircuitBreaker, withRetry } from "../utils/resilience.js";

const ERC20_ABI = parseAbi([
  "function transfer(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

interface WithdrawalMetadata {
  proof?: { signer: string; message: string; signature: string };
  blockchainId: string;
  tokenId: string;
  address: string;
  amountRaw: string;
}

export class WithdrawalBot {
  public bot: Bot;
  private isRunning = false;
  private withdrawalBreaker = new CircuitBreaker("withdrawal-broadcast");

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private chainService: BlockchainService,
    private logger: Logger
  ) {
    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);

    this.bot.catch((err) => {
      const ctx = err.ctx;
      this.logger.error({ err: err.error, update_id: ctx.update.update_id }, "Bot Error");
    });

    this.setupListeners();
  }

  async start() {
    this.logger.info("🤖 Withdrawal Bot Starting...");
    this.isRunning = true;

    // Start the bot in polling mode; bot.start() is concurrent
    void this.bot.start({
      onStart: (botInfo) => {
        this.logger.info(`Telegram connected as @${botInfo.username}`);
      },
    });

    // Start the background queue processor
    await this.processQueue();
  }

  async stop() {
    this.isRunning = false;
    await this.bot.stop();
  }

  private async processQueue() {
    this.logger.info("📦 Queue Processor Started");
    while (this.isRunning) {
      try {
        // BLOCKING READ: block 2s to prevent tight loop
        const item = await this.redis.blpop("withdrawal_queue", 2);
        if (item) await this.handleRequest(item[1]);
      } catch (e) {
        this.logger.error(e, "Queue Processing Error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handleRequest(requestId: string) {
    const tx = await this.prisma.ledgerEntry.findUnique({
      where: { id: requestId },
      include: { account: { include: { user: true } } },
    });
    if (!tx?.metadata) return;

    const user = tx.account.user;
    const meta = tx.metadata as unknown as WithdrawalMetadata;
    const amountUsd = Math.abs(tx.amount / 100);

    const isSigValid = await this.verifyWithdrawalProof(meta, user.address);

    const dailyTotal = await this.prisma.ledgerEntry.aggregate({
      where: {
        type: "WITHDRAWAL",
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
      _sum: { amount: true },
    });
    const currentDaily = Math.abs((dailyTotal._sum.amount ?? 0) / 100);

    let riskAlert = "";
    if (amountUsd > config.MAX_SINGLE_WITHDRAWAL_USD)
      riskAlert += "\n⚠️ <b>Exceeds Single Limit!</b>";
    if (currentDaily + amountUsd > config.MAX_DAILY_WITHDRAWAL_USD)
      riskAlert += "\n⚠️ <b>Exceeds Daily Limit!</b>";

    const msg = `
💸 <b>Withdrawal Request</b>
User: ${user.username}
Amount: $${amountUsd.toFixed(2)}
Sig: ${isSigValid ? "✅ Valid" : "❌ INVALID"}
${riskAlert}

Blockchain: ${meta.blockchainId}
Dest: <code>${meta.address}</code>
`;

    const keyboard = new InlineKeyboard();
    if (isSigValid) {
      keyboard.text("✅ Approve", `APP:${requestId}`);
    }
    keyboard.text("❌ Reject", `REJ:${requestId}`);

    try {
      await this.bot.api.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (e) {
      this.logger.error(e, "Failed to send Telegram notification");
    }
  }

  private setupListeners() {
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const [action, reqId] = data.split(":");
      const lockKey = `lock:${reqId}`;

      // Distributed lock to prevent double clicking
      const locked = await this.redis.set(lockKey, "1", "EX", 60, "NX");
      if (!locked) {
        return ctx.answerCallbackQuery({ text: "Processing..." });
      }

      try {
        const exists = await this.prisma.paymentTransaction.findUnique({
          where: { ledgerEntryId: reqId },
        });

        if (exists && exists.status !== "PENDING") {
          if (ctx.msg) {
            await ctx.reply("⚠️ Transaction already processed.", {
              reply_parameters: { message_id: ctx.msg.message_id },
            });
          }
          return;
        }

        if (action === "APP") await this.approve(ctx, reqId);
        if (action === "REJ") await this.reject(ctx, reqId);

        await ctx.answerCallbackQuery({ text: "Done" });
      } catch (e) {
        const err = e as Error;
        this.logger.error(err);
        // Reply to the chat where the button was clicked
        await ctx.reply(`Error: ${err.message}`);
      } finally {
        await this.redis.del(lockKey);
      }
    });
  }

  private async approve(ctx: Context, reqId: string) {
    const tx = await this.prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: reqId },
      include: { account: { include: { user: true } } },
    });
    const meta = tx.metadata as unknown as WithdrawalMetadata;

    if (!(await this.verifyWithdrawalProof(meta, tx.account.user.address))) {
      await this.rejectWithReason(ctx, reqId, "Invalid or expired withdrawal signature");
      throw new Error("Invalid or expired withdrawal signature");
    }

    if (Math.abs(tx.amount / 100) > config.MAX_SINGLE_WITHDRAWAL_USD)
      throw new Error("Limit exceeded");

    const chain = await this.prisma.blockchain.findUniqueOrThrow({
      where: { id: meta.blockchainId },
    });
    const token = await this.prisma.token.findUniqueOrThrow({ where: { id: meta.tokenId } });
    const client = this.chainService.getHotWalletClient(chain);

    const hash = await withRetry(async () => {
      const nonce = await this.chainService.getNextHotWalletNonce(chain);
      return client.writeContract({
        address: token.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [meta.address as `0x${string}`, BigInt(meta.amountRaw)],
        chain: null,
        account: client.account!,
        nonce,
      });
    }, this.withdrawalBreaker);

    // PaymentTransaction was created atomically by the API on balance debit
    await this.prisma.paymentTransaction.update({
      where: { ledgerEntryId: reqId },
      data: {
        txHash: hash,
        status: "PROCESSING",
      },
    });

    const url = this.chainService.getExplorerLink(chain, hash);

    await ctx.editMessageText(`✅ <b>Sent!</b>\n<a href="${url}">View TX</a>`, {
      parse_mode: "HTML",
    });
  }

  private async reject(ctx: Context, reqId: string) {
    await this.rejectWithReason(ctx, reqId, "Admin Rejected");

    await ctx.editMessageText("❌ <b>Rejected.</b> Funds returned.", {
      parse_mode: "HTML",
    });
  }

  private async rejectWithReason(ctx: Context, reqId: string, reason: string) {
    const tx = await this.prisma.ledgerEntry.findUniqueOrThrow({ where: { id: reqId } });

    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: tx.accountId },
        data: { balance: { increment: Math.abs(tx.amount) } },
      }),
      this.prisma.ledgerEntry.create({
        data: {
          accountId: tx.accountId,
          amount: Math.abs(tx.amount),
          type: "REFUND",
          referenceId: reqId,
          metadata: { reason },
        },
      }),
      this.prisma.paymentTransaction.update({
        where: { ledgerEntryId: reqId },
        data: { status: "REJECTED", confirmedAt: new Date() },
      }),
    ]);
  }

  private async verifyWithdrawalProof(
    meta: WithdrawalMetadata,
    expectedAddress: string
  ): Promise<boolean> {
    try {
      if (!meta.proof) return false;
      const valid = await verifyMessage({
        address: meta.proof.signer as `0x${string}`,
        message: meta.proof.message,
        signature: meta.proof.signature as `0x${string}`,
      });
      if (!valid || meta.proof.signer.toLowerCase() !== expectedAddress.toLowerCase()) {
        return false;
      }

      const timestampMatch = /Timestamp:\s*(\d+)/i.exec(meta.proof.message);
      if (!timestampMatch) return false;
      const timestamp = Number(timestampMatch[1]);
      if (!Number.isFinite(timestamp)) return false;
      return Math.abs(Date.now() - timestamp) <= config.WITHDRAWAL_SIGNATURE_MAX_AGE_MS;
    } catch (e) {
      this.logger.warn(e, "Signature verification failed");
      return false;
    }
  }
}
