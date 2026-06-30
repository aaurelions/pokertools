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

/**
 * Recovery scanner interval in milliseconds (default 5 minutes).
 * Periodically scans for withdrawals stuck in non-terminal states.
 */
const RECOVERY_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Maximum age in milliseconds for a withdrawal in AWAITING_BROADCAST state
 * before it is considered stuck and eligible for auto-refund (default 6 hours).
 */
const STUCK_WITHDRAWAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export class WithdrawalBot {
  public bot: Bot;
  private isRunning = false;
  private withdrawalBreaker = new CircuitBreaker("withdrawal-broadcast");
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

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

  async start(): Promise<void> {
    this.logger.info("🤖 Withdrawal Bot Starting...");
    this.isRunning = true;

    // Start the bot in polling mode; bot.start() is concurrent
    void this.bot.start({
      onStart: (botInfo) => {
        this.logger.info(`Telegram connected as @${botInfo.username}`);
      },
    });

    // Start the background queue processor
    void this.processQueue();

    // Start the recovery scanner (check for stuck withdrawals)
    await this.startRecoveryScanner();
  }

  async stop() {
    this.isRunning = false;
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    await this.bot.stop();
  }

  /**
   * Recovery scanner: periodically checks for withdrawals stuck in non-terminal
   * states and either refunds them or alerts admins.
   *
   * Handles:
   * - AWAITING_BROADCAST: Withdrawals queued but never picked up (bot restart while queue has items)
   * - BROADCASTING: Sent to mempool but not confirmed for too long
   * - BROADCAST_FAILED: RPC error during broadcast, needs admin attention
   * - STUCK_IN_MEMPOOL: Broadcast but stuck due to low gas
   */
  private async startRecoveryScanner() {
    this.logger.info({ intervalMs: RECOVERY_SCAN_INTERVAL_MS }, "🔄 Recovery scanner started");

    // Run immediately on start (catch any issues from before restart)
    await this.runRecoveryScan();

    this.recoveryTimer = setInterval(() => {
      void this.runRecoveryScan();
    }, RECOVERY_SCAN_INTERVAL_MS);
  }

  private async runRecoveryScan() {
    try {
      const stuckCutoff = new Date(Date.now() - STUCK_WITHDRAWAL_MAX_AGE_MS);

      // Find withdrawals stuck in AWAITING_BROADCAST for too long
      const stuckAwaiting = await this.prisma.paymentTransaction.findMany({
        where: {
          type: "WITHDRAWAL",
          recoveryState: "AWAITING_BROADCAST",
          status: "PENDING",
          createdAt: { lt: stuckCutoff },
        },
        include: {
          user: { select: { id: true, username: true } },
          ledgerEntry: true,
        },
      });

      if (stuckAwaiting.length > 0) {
        this.logger.warn(
          { count: stuckAwaiting.length },
          "Found stuck withdrawals in AWAITING_BROADCAST - auto-refunding"
        );

        for (const withdrawal of stuckAwaiting) {
          await this.autoRefundStuckWithdrawal(withdrawal);
        }
      }

      // Find withdrawals stuck in BROADCAST_FAILED
      const failedBroadcast = await this.prisma.paymentTransaction.findMany({
        where: {
          type: "WITHDRAWAL",
          recoveryState: "BROADCAST_FAILED",
          status: "PENDING",
        },
        include: {
          user: { select: { id: true, username: true } },
          blockchain: { select: { name: true } },
        },
      });

      if (failedBroadcast.length > 0) {
        this.logger.warn(
          { count: failedBroadcast.length },
          "Found withdrawals with BROADCAST_FAILED state - requires admin attention"
        );

        // Alert admins via Telegram
        for (const withdrawal of failedBroadcast) {
          try {
            await this.bot.api.sendMessage(
              config.TELEGRAM_ADMIN_CHAT_ID,
              `⚠️ <b>Failed Broadcast</b>\n` +
                `ID: ${withdrawal.id}\n` +
                `User: ${withdrawal.user.username}\n` +
                `Amount: $${(withdrawal.amountCredit / 100).toFixed(2)}\n` +
                `Chain: ${withdrawal.blockchain?.name ?? "N/A"}\n` +
                `Status: BROADCAST_FAILED\n\n` +
                `Manual action required: refund or retry.`,
              { parse_mode: "HTML" }
            );
          } catch (e) {
            this.logger.error(e, "Failed to send failed-broadcast alert");
          }
        }
      }

      // Find PENDING withdrawals with txHash that haven't been confirmed (stuck in mempool)
      const stuckMempool = await this.prisma.paymentTransaction.findMany({
        where: {
          type: "WITHDRAWAL",
          status: "PROCESSING",
          txHash: { not: null },
          createdAt: { lt: stuckCutoff },
        },
        include: {
          user: { select: { id: true, username: true } },
          blockchain: true,
        },
      });

      for (const withdrawal of stuckMempool) {
        // Check if the transaction exists on chain
        try {
          const client = this.chainService.getPublicClient(withdrawal.blockchain);
          const receipt = await client.getTransactionReceipt({
            hash: withdrawal.txHash as `0x${string}`,
          });

          if (receipt.status === "success") {
            // Transaction confirmed! Update status
            await this.prisma.paymentTransaction.update({
              where: { id: withdrawal.id },
              data: {
                status: "CONFIRMED",
                recoveryState: null,
                confirmedAt: new Date(),
              },
            });
            this.logger.info(
              { withdrawalId: withdrawal.id, txHash: withdrawal.txHash },
              "Stuck withdrawal confirmed on chain during recovery scan"
            );
          } else if (receipt.status === "reverted") {
            // Transaction reverted - mark as failed and refund
            await this.markFailedAndRefund(withdrawal, "Transaction reverted on chain");
          }
          // If still pending, update recoveryState to STUCK_IN_MEMPOOL
          else {
            await this.prisma.paymentTransaction.update({
              where: { id: withdrawal.id },
              data: { recoveryState: "STUCK_IN_MEMPOOL" },
            });
          }
        } catch (e: unknown) {
          const err = e as { message?: string };
          // If tx not found, it may have been dropped from mempool
          if (err.message?.includes("not found") || err.message?.includes("could not be found")) {
            await this.prisma.paymentTransaction.update({
              where: { id: withdrawal.id },
              data: { recoveryState: "STUCK_IN_MEMPOOL" },
            });
          }
          this.logger.warn(
            { withdrawalId: withdrawal.id, error: err },
            "Error checking stuck withdrawal status"
          );
        }
      }

      // Log summary
      if (stuckAwaiting.length > 0 || failedBroadcast.length > 0 || stuckMempool.length > 0) {
        this.logger.info(
          {
            autoRefunded: stuckAwaiting.length,
            failedBroadcast: failedBroadcast.length,
            stuckMempool: stuckMempool.length,
          },
          "Recovery scan completed"
        );
      }
    } catch (e) {
      this.logger.error(e, "Recovery scan error");
    }
  }

  /**
   * Auto-refund a stuck withdrawal: return funds from PENDING_WITHDRAWAL to MAIN
   * and mark the payment transaction as CANCELLED with RECOVERY_REFUNDED state.
   */
  private async autoRefundStuckWithdrawal(
    withdrawal: Awaited<ReturnType<typeof this.prisma.paymentTransaction.findFirstOrThrow>> & {
      user?: { id: string; username: string };
      ledgerEntry?: { accountId: string } | null;
    }
  ) {
    const userId = withdrawal.userId;
    const amount = withdrawal.amountCredit;

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Debit PENDING_WITHDRAWAL account (release held funds)
        const pendingAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId,
              currency: "USDC",
              type: "PENDING_WITHDRAWAL",
            },
          },
        });

        if (pendingAccount && pendingAccount.balance >= amount) {
          await tx.account.update({
            where: { id: pendingAccount.id },
            data: { balance: { decrement: amount } },
          });
        }

        // 2. Credit MAIN account (return funds to available balance)
        const mainAccount = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: {
              userId,
              currency: "USDC",
              type: "MAIN",
            },
          },
        });

        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { increment: amount } },
        });

        // 3. Create REFUND ledger entry
        await tx.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: amount,
            type: "REFUND",
            referenceId: withdrawal.id,
            metadata: {
              reason: "Auto-refund: withdrawal stuck in AWAITING_BROADCAST",
              originalPaymentTxId: withdrawal.id,
            },
          },
        });

        // 4. Update payment transaction status
        await tx.paymentTransaction.update({
          where: { id: withdrawal.id },
          data: {
            status: "CANCELLED",
            recoveryState: "RECOVERY_REFUNDED",
            confirmedAt: new Date(),
          },
        });
      });

      this.logger.info(
        {
          withdrawalId: withdrawal.id,
          userId,
          amount,
        },
        "Auto-refunded stuck withdrawal"
      );

      // Notify admin
      try {
        await this.bot.api.sendMessage(
          config.TELEGRAM_ADMIN_CHAT_ID,
          `🔄 <b>Auto-Refunded</b>\n` +
            `ID: ${withdrawal.id}\n` +
            `User: ${withdrawal.user?.username ?? userId}\n` +
            `Amount: $${(amount / 100).toFixed(2)}\n` +
            `Reason: Stuck in AWAITING_BROADCAST for >${STUCK_WITHDRAWAL_MAX_AGE_MS / 3600000}h`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        this.logger.error(e, "Failed to send auto-refund notification");
      }
    } catch (e) {
      this.logger.error(
        { withdrawalId: withdrawal.id, error: e },
        "Failed to auto-refund stuck withdrawal"
      );
    }
  }

  /**
   * Mark a withdrawal as FAILED and refund funds to user.
   */
  private async markFailedAndRefund(
    withdrawal: { id: string; userId: string; amountCredit: number },
    reason: string
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Return funds from PENDING_WITHDRAWAL to MAIN
        const pendingAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId: withdrawal.userId,
              currency: "USDC",
              type: "PENDING_WITHDRAWAL",
            },
          },
        });

        if (pendingAccount && pendingAccount.balance >= withdrawal.amountCredit) {
          await tx.account.update({
            where: { id: pendingAccount.id },
            data: { balance: { decrement: withdrawal.amountCredit } },
          });
        }

        const mainAccount = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: {
              userId: withdrawal.userId,
              currency: "USDC",
              type: "MAIN",
            },
          },
        });

        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { increment: withdrawal.amountCredit } },
        });

        await tx.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: withdrawal.amountCredit,
            type: "REFUND",
            referenceId: withdrawal.id,
            metadata: { reason },
          },
        });

        await tx.paymentTransaction.update({
          where: { id: withdrawal.id },
          data: {
            status: "FAILED",
            recoveryState: "RECOVERY_REFUNDED",
            confirmedAt: new Date(),
          },
        });
      });
    } catch (e) {
      this.logger.error(
        { withdrawalId: withdrawal.id, error: e },
        "Failed to mark withdrawal as failed and refund"
      );
    }
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

    // Update recoveryState to BROADCASTING before sending the transaction
    await this.prisma.paymentTransaction.updateMany({
      where: {
        ledgerEntryId: reqId,
        status: "PENDING",
      },
      data: {
        recoveryState: "BROADCASTING",
      },
    });

    let hash: `0x${string}`;
    try {
      hash = await withRetry(async () => {
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
    } catch (broadcastErr) {
      // Broadcast failed - update recoveryState so scanner can detect it
      await this.prisma.paymentTransaction.updateMany({
        where: { ledgerEntryId: reqId },
        data: {
          recoveryState: "BROADCAST_FAILED",
        },
      });

      this.logger.error({ error: broadcastErr, requestId: reqId }, "Withdrawal broadcast failed");
      throw broadcastErr;
    }

    // PaymentTransaction was created atomically by the API on balance hold
    // Now that broadcast succeeded, debit PENDING_WITHDRAWAL account and update
    await this.prisma.$transaction(async (dbTx) => {
      // Debit the PENDING_WITHDRAWAL holding account (funds are now spent)
      const pendingAccount = await dbTx.account.findUnique({
        where: {
          userId_currency_type: {
            userId: tx.account.userId,
            currency: "USDC",
            type: "PENDING_WITHDRAWAL",
          },
        },
      });

      if (pendingAccount) {
        await dbTx.account.update({
          where: { id: pendingAccount.id },
          data: { balance: { decrement: Math.abs(tx.amount) } },
        });
      }

      // Update payment transaction
      await dbTx.paymentTransaction.update({
        where: { ledgerEntryId: reqId },
        data: {
          txHash: hash,
          status: "PROCESSING",
          recoveryState: null, // Clear recovery state - broadcast succeeded
        },
      });
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
    const tx = await this.prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: reqId },
      include: { account: { include: { user: true } } },
    });

    const userId = tx.account.user.id;
    const refundAmount = Math.abs(tx.amount);

    await this.prisma.$transaction(async (dbTx) => {
      // 1. Debit PENDING_WITHDRAWAL account (release held funds)
      const pendingAccount = await dbTx.account.findUnique({
        where: {
          userId_currency_type: {
            userId,
            currency: "USDC",
            type: "PENDING_WITHDRAWAL",
          },
        },
      });

      if (pendingAccount && pendingAccount.balance >= refundAmount) {
        await dbTx.account.update({
          where: { id: pendingAccount.id },
          data: { balance: { decrement: refundAmount } },
        });
      }

      // 2. Credit MAIN account (return funds to available balance)
      const mainAccount = await dbTx.account.findUniqueOrThrow({
        where: {
          userId_currency_type: {
            userId,
            currency: "USDC",
            type: "MAIN",
          },
        },
      });

      await dbTx.account.update({
        where: { id: mainAccount.id },
        data: { balance: { increment: refundAmount } },
      });

      // 3. Create REFUND ledger entry
      await dbTx.ledgerEntry.create({
        data: {
          accountId: mainAccount.id,
          amount: refundAmount,
          type: "REFUND",
          referenceId: reqId,
          metadata: { reason },
        },
      });

      // 4. Update payment transaction with recovery state
      await dbTx.paymentTransaction.update({
        where: { ledgerEntryId: reqId },
        data: {
          status: "REJECTED",
          recoveryState: "RECOVERY_REFUNDED",
          confirmedAt: new Date(),
        },
      });
    });
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
