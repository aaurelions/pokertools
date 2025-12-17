import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { z } from "zod";

const withdrawSchema = z.object({
  amount: z.number().positive().max(1000000), // Max $10,000 per withdrawal
  blockchainId: z.string().cuid(),
  tokenId: z.string().cuid(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
  message: z.string(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature format"),
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
        details: validation.error.issues,
      });
    }

    const { amount, blockchainId, tokenId, address, message, signature } = validation.data;

    // 1. Get user and verify they own the signing address
    const user = await fastify.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { address: true, username: true },
    });

    // 2. Verify the signature
    let isValid = false;
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

    // 3. Verify the message contains withdrawal details to prevent replay attacks
    const expectedMessage = `Withdraw ${amount} USD to ${address}`;
    if (!message.includes(expectedMessage) && message !== expectedMessage) {
      return reply.code(400).send({
        error: "Message does not match withdrawal details",
        expected: expectedMessage,
      });
    }

    // 4. Verify blockchain and token exist
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

    // 5. Get user's MAIN account
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

    // 6. Check balance (amount is in USD cents, i.e., 100 = $1.00)
    const amountInCents = Math.floor(amount * 100);
    if (mainAccount.balance < amountInCents) {
      return reply.code(400).send({
        error: "Insufficient balance",
        available: mainAccount.balance / 100,
        requested: amount,
      });
    }

    // 7. Calculate raw amount for blockchain (convert USD to token amount)
    // For now, assuming 1:1 for USDC (6 decimals)
    const amountRaw = (BigInt(amountInCents) * BigInt(10 ** token.decimals)) / BigInt(100);

    // 8. Create withdrawal request in database (atomic transaction)
    const ledgerEntry = await fastify.prisma.$transaction(
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
            },
          },
        });

        return entry;
      }
    );

    // 9. Queue withdrawal for admin approval
    await fastify.redis.rpush("withdrawal_queue", ledgerEntry.id);

    fastify.log.info(
      {
        userId,
        ledgerEntryId: ledgerEntry.id,
        amount: amountInCents,
        destination: address,
      },
      "Withdrawal request queued"
    );

    return {
      id: ledgerEntry.id,
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
