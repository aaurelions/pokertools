import { Bot, InlineKeyboard, Context } from "grammy";
import { PrismaClient } from "../../../api/generated/prisma/index.js";
import type { Redis } from "ioredis";
import { BlockchainService } from "./BlockchainService.js";
import { config } from "../config.js";
import type { Logger } from "pino";
import { parseAbi, verifyMessage } from "viem";

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

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private chainService: BlockchainService,
    private logger: Logger
  ) {
    // Initialize grammY Bot
    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);

    // Global Error Handler for the Bot
    this.bot.catch((err) => {
      const ctx = err.ctx;
      this.logger.error({ err: err.error, update_id: ctx.update.update_id }, "Bot Error");
    });

    this.setupListeners();
  }

  async start() {
    this.logger.info("🤖 Withdrawal Bot Starting...");
    this.isRunning = true;

    // Start the bot (Polling mode)
    // Note: In a heavy production app, consider using grammY runner
    // bot.start() is concurrent, so we don't await it here if we want to run the queue too
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
        // Blocks for 2 seconds waiting for data to prevent tight loops
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
    if (!tx || !tx.metadata) return;

    const user = tx.account.user;
    const meta = tx.metadata as unknown as WithdrawalMetadata;
    const amountUsd = Math.abs(tx.amount / 100);

    // 1. Verify Signature
    let isSigValid = false;
    try {
      if (meta.proof) {
        const valid = await verifyMessage({
          address: meta.proof.signer as `0x${string}`,
          message: meta.proof.message,
          signature: meta.proof.signature as `0x${string}`,
        });
        if (valid && meta.proof.signer.toLowerCase() === user.address.toLowerCase()) {
          isSigValid = true;
        }
      }
    } catch (e) {
      this.logger.warn(e, "Signature verification failed");
    }

    // 2. Check Risk Limits
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

    // 3. Build Keyboard using grammY builder
    const keyboard = new InlineKeyboard();
    if (isSigValid) {
      keyboard.text("✅ Approve", `APP:${requestId}`);
    }
    keyboard.text("❌ Reject", `REJ:${requestId}`);

    try {
      // Use bot.api to send messages initiated by the server (not a reply to a user)
      await this.bot.api.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (e) {
      this.logger.error(e, "Failed to send Telegram notification");
    }
  }

  private setupListeners() {
    // grammY allows filtering updates specifically for callback queries
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

        if (exists) {
          // 'ctx.msg' is a shortcut for the message object in grammY
          // We use 'msg' because callback queries are always attached to a message
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

  // We pass the context 'ctx' to helper methods to utilize convenient shortcuts
  private async approve(ctx: Context, reqId: string) {
    const tx = await this.prisma.ledgerEntry.findUniqueOrThrow({ where: { id: reqId } });
    const meta = tx.metadata as unknown as WithdrawalMetadata;

    if (Math.abs(tx.amount / 100) > config.MAX_SINGLE_WITHDRAWAL_USD)
      throw new Error("Limit exceeded");

    const chain = await this.prisma.blockchain.findUniqueOrThrow({
      where: { id: meta.blockchainId },
    });
    const token = await this.prisma.token.findUniqueOrThrow({ where: { id: meta.tokenId } });
    const client = this.chainService.getHotWalletClient(chain);

    // Blockchain Write
    const hash = await client.writeContract({
      address: token.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [meta.address as `0x${string}`, BigInt(meta.amountRaw)],
      chain: null,
      account: client.account!,
    });

    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: tx.accountId },
      include: { user: true },
    });

    // DB Record
    await this.prisma.paymentTransaction.create({
      data: {
        userId: account.userId,
        type: "WITHDRAWAL",
        ledgerEntryId: reqId,
        txHash: hash,
        blockchainId: chain.id,
        tokenId: token.id,
        address: meta.address,
        amountRaw: meta.amountRaw,
        amountCredit: Math.abs(tx.amount),
        status: "PROCESSING",
      },
    });

    const url = this.chainService.getExplorerLink(chain, hash);

    // Update the message containing the button
    await ctx.editMessageText(`✅ <b>Sent!</b>\n<a href="${url}">View TX</a>`, {
      parse_mode: "HTML",
    });
  }

  private async reject(ctx: Context, reqId: string) {
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
          metadata: { reason: "Admin Rejected" },
        },
      }),
    ]);

    // Update the message containing the button
    await ctx.editMessageText("❌ <b>Rejected.</b> Funds returned.", {
      parse_mode: "HTML",
    });
  }
}
