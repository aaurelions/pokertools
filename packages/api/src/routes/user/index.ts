import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { z } from "zod";
import { config } from "../../config.js";

const withdrawSchema = z.object({
  amount: z
    .number()
    .positive()
    .max(config.MAX_WITHDRAWAL_AMOUNT_CENTS / 100),
  blockchainId: z.string().cuid(),
  tokenId: z.string().cuid(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
  message: z.string().min(1).max(1024),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature format"),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryTransient<T>(operation: () => Promise<T>, attempts = 10): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(100 * attempt);
    }
  }
  throw lastError;
}

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /user/me - Get user profile and balances
  fastify.get("/me", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const [user, balances] = await Promise.all([
      fastify.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          address: true,
          role: true,
          createdAt: true,
        },
      }),
      fastify.financialManager.getBalances(userId),
    ]);

    return {
      ...user,
      balances: {
        main: balances.main,
        inPlay: balances.inPlay,
        pendingWithdrawal: balances.pendingWithdrawal,
      },
    };
  });

  // GET /user/history - Get hand history
  fastify.get("/history", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const entries = await retryTransient(async () => {
      const accounts = await fastify.prisma.account.findMany({
        where: { userId },
        select: { id: true },
      });
      const accountIds = accounts.map((account) => account.id);

      return accountIds.length > 0
        ? fastify.prisma.ledgerEntry.findMany({
            where: {
              accountId: { in: accountIds },
              type: { in: ["HAND_WIN", "HAND_LOSS"] },
            },
            take: 20,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              amount: true,
              type: true,
              referenceId: true,
              createdAt: true,
            },
          })
        : [];
    }).catch((error: unknown) => {
      fastify.log.warn({ userId, error }, "Unable to load user hand history");
      return [];
    });

    return {
      history: entries.map((entry) => ({
        id: entry.id,
        amount: Number(entry.amount),
        type: entry.type,
        referenceId: entry.referenceId,
        createdAt:
          entry.createdAt instanceof Date
            ? entry.createdAt.toISOString()
            : new Date(entry.createdAt).toISOString(),
      })),
    };
  });

  // POST /user/withdraw - Request withdrawal with signature verification
  fastify.post("/withdraw", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { userId } = request.user;

    // Validate request body safely
    const validation = withdrawSchema.safeParse(request.body);

    if (!validation.success) {
      return reply.code(400).send({
        error: "Validation failed",
      });
    }

    const { amount, blockchainId, tokenId, address, message, signature, idempotencyKey } =
      validation.data;

    // Idempotency check: if idempotencyKey is provided, return the existing
    // DB-backed outbox row instead of relying on recent JSON metadata scans.
    if (idempotencyKey) {
      const existingPayment = await fastify.prisma.paymentTransaction.findUnique({
        where: { idempotencyKey },
        include: { ledgerEntry: true, blockchain: true, token: true },
      });

      if (existingPayment?.userId === userId && existingPayment.type === "WITHDRAWAL") {
        return reply.code(200).send({
          id: existingPayment.id,
          ledgerEntryId: existingPayment.ledgerEntryId,
          status: existingPayment.status,
          amount: Number(existingPayment.amountCredit) / 100,
          destination: existingPayment.address,
          blockchain: existingPayment.blockchain.name,
          token: existingPayment.token.symbol,
          message: "Withdrawal already submitted (idempotent)",
        });
      }
    }

    // Get user and verify they own the signing address
    const user = await fastify.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { address: true, username: true },
    });

    // Verify the signature
    let isValid: boolean;
    try {
      isValid = await verifyMessage({
        address: user.address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch (error) {
      fastify.log.warn({ error, userId }, "Signature verification failed");
      return reply.code(400).send({ error: "Invalid signature" });
    }

    if (!isValid) {
      return reply.code(400).send({ error: "Signature verification failed" });
    }

    // Verify the message contains withdrawal details with nonce/timestamp to prevent replay.
    // Format: "Withdraw {amount} USD to {address}\nNonce: {nonce}\nTimestamp: {timestamp}"
    const hasNonceAndTimestamp =
      message.includes(`Withdraw ${amount} USD to ${address}\nNonce: `) &&
      message.includes("\nTimestamp: ");

    if (!hasNonceAndTimestamp) {
      return reply.code(400).send({
        error:
          "Message does not match withdrawal details. Expected format with nonce and timestamp.",
      });
    }

    const nonceMatch = /\nNonce: ([A-Za-z0-9._:-]{8,128})\n/.exec(message);
    const timestampMatch = /Timestamp: (\d+)/.exec(message);
    if (!nonceMatch || !timestampMatch) {
      return reply.code(400).send({
        error: "Withdrawal message nonce or timestamp is invalid.",
      });
    }

    const msgTimestamp = parseInt(timestampMatch[1], 10);
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    if (Math.abs(now - msgTimestamp) > fiveMinutes) {
      return reply.code(400).send({
        error: "Withdrawal message has expired. Please sign a new message.",
      });
    }

    const effectiveIdempotencyKey = idempotencyKey ?? nonceMatch[1];
    const existingPaymentByNonce = await fastify.prisma.paymentTransaction.findUnique({
      where: { idempotencyKey: effectiveIdempotencyKey },
      include: { ledgerEntry: true, blockchain: true, token: true },
    });
    if (existingPaymentByNonce?.userId === userId && existingPaymentByNonce.type === "WITHDRAWAL") {
      return reply.code(200).send({
        id: existingPaymentByNonce.id,
        ledgerEntryId: existingPaymentByNonce.ledgerEntryId,
        status: existingPaymentByNonce.status,
        amount: Number(existingPaymentByNonce.amountCredit) / 100,
        destination: existingPaymentByNonce.address,
        blockchain: existingPaymentByNonce.blockchain.name,
        token: existingPaymentByNonce.token.symbol,
        message: "Withdrawal already submitted (idempotent)",
      });
    }

    if (existingPaymentByNonce && existingPaymentByNonce.userId !== userId) {
      return reply.code(409).send({
        error: "Idempotency key already used",
      });
    }

    // Verify blockchain and token exist
    const [blockchain, token] = await Promise.all([
      fastify.prisma.blockchain.findUnique({
        where: { id: blockchainId, isEnabled: true },
      }),
      fastify.prisma.token.findUnique({
        where: { id: tokenId, isEnabled: true },
      }),
    ]);

    if (!blockchain) {
      return reply.code(400).send({ error: "Blockchain not found or disabled" });
    }

    if (!token || token.blockchainId !== blockchainId) {
      return reply.code(400).send({ error: "Token not found or does not match blockchain" });
    }

    // Get user's MAIN account
    const mainAccount = await fastify.prisma.account.findUnique({
      where: {
        userId_currency_type: {
          userId,
          currency: config.DEFAULT_CURRENCY,
          type: "MAIN",
        },
      },
    });

    if (!mainAccount) {
      return reply.code(400).send({ error: "Account not found" });
    }

    // Check balance (amount is in USD cents, i.e., 100 = $1.00)
    const amountInCents = Math.floor(amount * 100);
    const amountCentsBigInt = BigInt(amountInCents);
    const risk = await fastify.riskManager.assertAllowed({
      userId,
      endpoint: "withdraw",
      request,
      amountCents: amountInCents,
    });
    if (mainAccount.balance < amountCentsBigInt) {
      return reply.code(400).send({
        error: "Insufficient balance",
        available: Number(mainAccount.balance) / 100,
        requested: amount,
      });
    }

    // Convert USD cents to on-chain token amount using token's configured decimals
    const amountRaw = (BigInt(amountInCents) * BigInt(10 ** token.decimals)) / BigInt(100);

    // Enforce minimum withdrawal amount from token configuration
    const minDepositBigInt = BigInt(token.minDeposit);
    if (amountRaw < minDepositBigInt) {
      return reply.code(400).send({
        error: `Withdrawal amount below minimum. Minimum: ${Number(minDepositBigInt) / 10 ** token.decimals} ${token.symbol}`,
      });
    }

    // --- PENDING HOLD SEMANTICS ---
    // Instead of immediately debiting MAIN (which risks permanent fund lock if the
    // withdrawal bot fails), move funds to a PENDING_WITHDRAWAL holding account.
    // This ensures funds are never lost: they exist in either MAIN or PENDING_WITHDRAWAL.
    // Recovery scanner in the admin withdrawal-bot can detect stuck withdrawals and
    // return funds from PENDING_WITHDRAWAL back to MAIN.
    const result = await fastify.prisma.$transaction(
      async (
        tx: Omit<
          typeof fastify.prisma,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        // 1. Debit MAIN account (move funds out of available balance)
        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { decrement: amountCentsBigInt } },
        });

        // 2. Credit PENDING_WITHDRAWAL account (hold funds in recoverable state)
        // Use upsert in case the user doesn't have a PENDING_WITHDRAWAL account yet
        await tx.account.upsert({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "PENDING_WITHDRAWAL",
            },
          },
          create: {
            userId,
            currency: config.DEFAULT_CURRENCY,
            type: "PENDING_WITHDRAWAL",
            balance: amountCentsBigInt,
          },
          update: {
            balance: { increment: amountCentsBigInt },
          },
        });

        // 3. Create LedgerEntry for the withdrawal request
        const entry = await tx.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: -amountCentsBigInt,
            type: "WITHDRAWAL",
            metadata: {
              blockchainId,
              tokenId,
              address,
              amountRaw: amountRaw.toString(),
              proof: {
                signer: user.address,
                message,
                signature,
              },
              idempotencyKey: effectiveIdempotencyKey,
            },
          },
        });

        // 4. Create PaymentTransaction with AWAITING_BROADCAST recovery state
        const paymentTx = await tx.paymentTransaction.create({
          data: {
            userId,
            type: "WITHDRAWAL",
            blockchainId,
            tokenId,
            address,
            amountRaw: amountRaw.toString(),
            amountCredit: amountCentsBigInt,
            status: "PENDING",
            recoveryState: "AWAITING_BROADCAST",
            ledgerEntryId: entry.id,
            idempotencyKey: effectiveIdempotencyKey,
          },
        });

        return { ledgerEntry: entry, paymentTx };
      }
    );

    fastify.log.info(
      {
        userId,
        ledgerEntryId: result.ledgerEntry.id,
        paymentTxId: result.paymentTx.id,
        amount: amountInCents,
        destination: address,
      },
      "Withdrawal request stored for admin processing"
    );

    await fastify.auditManager.record({
      actorId: userId,
      action: "WITHDRAWAL_REQUEST",
      resource: `payment:${result.paymentTx.id}`,
      request,
      riskScore: risk.score,
      metadata: { amount: amountInCents, destination: address, blockchainId, tokenId },
    });

    return {
      id: result.paymentTx.id,
      ledgerEntryId: result.ledgerEntry.id,
      status: "pending",
      amount,
      destination: address,
      blockchain: blockchain.name,
      token: token.symbol,
      message: "Withdrawal request submitted. Awaiting admin approval.",
    };
  });

  // GET /user/withdrawals - Get withdrawal history
  fastify.get("/withdrawals", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const withdrawals = await fastify.prisma.paymentTransaction.findMany({
      where: { userId, type: "WITHDRAWAL" },
      include: {
        blockchain: {
          select: {
            name: true,
            explorerUrl: true,
          },
        },
        token: {
          select: {
            symbol: true,
            decimals: true,
          },
        },
        ledgerEntry: {
          select: {
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return {
      withdrawals: withdrawals.map((withdrawal) => ({
        id: withdrawal.id,
        txHash: withdrawal.txHash,
        chain: withdrawal.blockchain.name,
        token: withdrawal.token.symbol,
        address: withdrawal.address,
        amountRaw: withdrawal.amountRaw,
        amountUSD: Number(withdrawal.amountCredit) / 100,
        status: withdrawal.status,
        createdAt: withdrawal.ledgerEntry?.createdAt || withdrawal.createdAt,
        confirmedAt: withdrawal.confirmedAt,
        explorerUrl: withdrawal.txHash
          ? `${withdrawal.blockchain.explorerUrl}/tx/${withdrawal.txHash}`
          : null,
      })),
    };
  });
};
