import type { FastifyPluginAsync } from "fastify";

export const financeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /finance/chains - List supported deposit options
  fastify.get("/chains", async () => {
    return fastify.prisma.blockchain.findMany({
      where: { isEnabled: true },
      include: {
        tokens: {
          where: { isEnabled: true },
          select: { id: true, symbol: true, name: true, decimals: true, minDeposit: true },
        },
      },
    });
  });

  // POST /finance/deposit/start - Generate address and start tracking
  fastify.post(
    "/deposit/start",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const { userId } = request.user;

      const { address, expiresAt } = await fastify.blockchainManager.startDepositSession(userId);

      return {
        address,
        expiresAt,
        message:
          "Deposit tracking active for 30 minutes. Send tokens to this address on any supported chain.",
      };
    }
  );

  // GET /finance/deposits - Get user's deposit history
  fastify.get(
    "/deposits",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const { userId } = request.user;

      const deposits = await fastify.prisma.paymentTransaction.findMany({
        where: { userId, type: "DEPOSIT" },
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
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deposits: deposits.map((deposit: any) => ({
          id: deposit.id,
          txHash: deposit.txHash,
          chain: deposit.blockchain.name,
          token: deposit.token.symbol,
          amountRaw: deposit.amountRaw,
          amountCredit: deposit.amountCredit,
          status: deposit.status,
          createdAt: deposit.createdAt,
          confirmedAt: deposit.confirmedAt,
          explorerUrl: `${deposit.blockchain.explorerUrl}/tx/${deposit.txHash}`,
        })),
      };
    }
  );

  // GET /finance/deposit/address - Get user's deposit address
  fastify.get(
    "/deposit/address",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const { userId } = request.user;

      const address = await fastify.blockchainManager.getUserDepositAddress(userId);

      return {
        address,
      };
    }
  );
};
