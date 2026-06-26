import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { z } from "zod";

const withdrawSchema = z.object({
  amount: z.number().positive().max(1000000), // Max $10,000 per withdrawal
  blockchainId: z.string().cuid(),
  tokenId: z.string().cuid(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
  message: z.string().min(1).max(1024),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature format"),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

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
      },
    };
  });

  // GET /user/history - Get hand history
  fastify.get("/history", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const entries = await fastify.prisma.ledgerEntry.findMany({
      where: {
        account: { userId },
        type: { in: ["HAND_WIN", "HAND_LOSS"] },
      },
      take: 20,
      orderBy: { createdAt: "desc" },
      include: {
        account: { select: { type: true } },
      },
    });

    return {
      history: entries.map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        type: entry.type,
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
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

    // 1. Idempotency check: if idempotencyKey is provided, return the existing
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
          amount: existingPayment.amountCredit / 100,
          destination: existingPayment.address,
          blockchain: existingPayment.blockchain.name,
          token: existingPayment.token.symbol,
          message: "Withdrawal already submitted (idempotent)",
        });
      }
    }

    // 2. Get user and verify they own the signing address
    const user = await fastify.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { address: true, username: true },
    });

    // 3. Verify the signature
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

    // 4. Verify the message contains withdrawal details with nonce/timestamp to prevent replay.
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
        amount: existingPaymentByNonce.amountCredit / 100,
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

    // 5. Verify blockchain and token exist
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

    // 6. Get user's MAIN account
    const mainAccount = await fastify.prisma.account.findUnique({
      where: {
        userId_currency_type: {
          userId,
          currency: "USDC",
          type: "MAIN",
        },
      },
    });

    if (!mainAccount) {
      return reply.code(400).send({ error: "Account not found" });
    }

    // 7. Check balance (amount is in USD cents, i.e., 100 = $1.00)
    const amountInCents = Math.floor(amount * 100);
    const risk = await fastify.riskManager.assertAllowed({
      userId,
      endpoint: "withdraw",
      request,
      amountCents: amountInCents,
    });
    if (mainAccount.balance < amountInCents) {
      return reply.code(400).send({
        error: "Insufficient balance",
        available: mainAccount.balance / 100,
        requested: amount,
      });
    }

    // 8. Calculate raw amount for blockchain (convert USD to token amount)
    // For now, assuming 1:1 for USDC (6 decimals)
    const amountRaw = (BigInt(amountInCents) * BigInt(10 ** token.decimals)) / BigInt(100);

    // 9. Enforce minimum withdrawal amount from token configuration
    const minDepositBigInt = BigInt(token.minDeposit);
    if (amountRaw < minDepositBigInt) {
      return reply.code(400).send({
        error: `Withdrawal amount below minimum. Minimum: ${Number(minDepositBigInt) / 10 ** token.decimals} ${token.symbol}`,
      });
    }

    // 10. Create withdrawal request in database (atomic transaction with PaymentTransaction)
    const result = await fastify.prisma.$transaction(
      async (
        tx: Omit<
          typeof fastify.prisma,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        // Debit from MAIN account
        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { decrement: amountInCents } },
        });

        // Create ledger entry for withdrawal
        const entry = await tx.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: -amountInCents,
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

        // Create PaymentTransaction in the SAME transaction (DB outbox pattern)
        // This ensures no gap between debit and withdrawal request creation
        const paymentTx = await tx.paymentTransaction.create({
          data: {
            userId,
            type: "WITHDRAWAL",
            blockchainId,
            tokenId,
            address,
            amountRaw: amountRaw.toString(),
            amountCredit: amountInCents,
            status: "PENDING",
            ledgerEntryId: entry.id,
            idempotencyKey: effectiveIdempotencyKey,
          },
        });

        return { ledgerEntry: entry, paymentTx };
      }
    );

    // 11. Queue withdrawal for admin approval (best-effort, PaymentTransaction is already in DB)
    await fastify.redis.rpush("withdrawal_queue", result.ledgerEntry.id).catch((err: Error) => {
      fastify.log.warn(
        { err, paymentTxId: result.paymentTx.id },
        "Failed to queue withdrawal in Redis, but PaymentTransaction saved in DB"
      );
    });

    fastify.log.info(
      {
        userId,
        ledgerEntryId: result.ledgerEntry.id,
        paymentTxId: result.paymentTx.id,
        amount: amountInCents,
        destination: address,
      },
      "Withdrawal request queued"
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
        amountUSD: withdrawal.amountCredit / 100,
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
