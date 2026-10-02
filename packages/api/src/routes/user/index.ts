import type { FastifyPluginAsync } from "fastify";
import { BalanceSchema } from "@pokertools/types";
import { config } from "../../config.js";
import { AtomicLedger } from "../../services/atomic-ledger.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryTransient<T>(
  operation: () => Promise<T>,
  attempts = config.RETRY_TRANSIENT_ATTEMPTS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(config.RETRY_TRANSIENT_BACKOFF_BASE_MS * attempt);
    }
  }
  throw lastError;
}

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  const ledger = new AtomicLedger(fastify.prisma);

  // GET /user/me - Get user profile and balances
  //
  // `chipBalances` is the canonical gameplay chip projection (integer chips as
  // decimal strings). `assetBalances` is the canonical multi-asset projection
  // (atomic decimal strings). The two are intentionally separate and are never
  // converted into one another; conversion requires a persisted EconomicPolicy.
  fastify.get("/me", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const [user, chipBalances, atomicAccounts] = await Promise.all([
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
      fastify.financialManager.getChipBalancesView(userId),
      ledger.listBalancesForOwner(fastify.prisma, userId),
    ]);

    const byAsset = new Map<string, Record<string, string>>();
    for (const account of atomicAccounts) {
      const bucket = byAsset.get(account.assetId) ?? {};
      bucket[account.class] = account.balanceAtomic;
      byAsset.set(account.assetId, bucket);
    }

    return {
      ...user,
      chipBalances,
      assetBalances: [...byAsset.entries()].map(([assetId, bucket]) =>
        BalanceSchema.parse({
          principalId: userId,
          assetId,
          availableAtomic: bucket.USER_AVAILABLE ?? "0",
          inPlayAtomic: bucket.IN_PLAY_RESERVE ?? "0",
          pendingWithdrawalAtomic: bucket.PENDING_WITHDRAWAL ?? "0",
          tournamentReserveAtomic: bucket.TOURNAMENT_RESERVE ?? "0",
          incidentObligationAtomic: bucket.INCIDENT_OBLIGATION ?? "0",
        })
      ),
    };
  });

  // GET /user/history - canonical chip journal history.
  //
  // Chips are integer gameplay units projected as decimal strings. This is the
  // append-only `ChipLedgerEntry` journal; no default currency or implicit rate.
  fastify.get("/history", { onRequest: [fastify.authenticate] }, async (request) => {
    const { userId } = request.user;

    const history = await retryTransient(() =>
      fastify.financialManager.getChipHistoryView(userId)
    ).catch((error: unknown) => {
      fastify.log.warn({ userId, error }, "Unable to load user chip history");
      return [];
    });

    return { history };
  });

  // Withdrawals belong to the asset-qualified EIP-712 finance routes, not chips.
};
