/**
 * Real-Anvil regression for the canonical deposit monitor sweep.
 *
 * Credited claims beyond one bounded page must still be reorg-checked. The old
 * `orderBy createdAt asc, take limit` window starved every later claim forever
 * while the oldest claims stayed CREDITED (they are never marked deep-final, so
 * they always occupied the window). This test proves the keyset cursor sweep
 * reaches claims past the page boundary AND re-checks them after wrapping.
 *
 * No chain state, claim, journal or confirmation is fabricated: every credit is
 * a real ERC20 transfer verified through the production API, and confirmations
 * are advanced by the production BullMQ monitor against real quorum-proxied
 * Anvil reads. Database writes only configure the asset fixture.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import type { Address } from "viem";
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";
import {
  bootstrapCanonicalDepositMonitor,
  CANONICAL_DEPOSIT_MONITOR_CURSOR_KEY,
} from "../../../api/src/workers/canonical-deposit-monitor.js";
import {
  attachTwoChainAnvil,
  deployMockAssetToken,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  readTokenDecimals,
  transferToken,
} from "./helpers/anvil-two-chain.js";
import { createAssetFixture, resolveAllOpenIncidents } from "./helpers/finance-fixtures.js";
import {
  bootFinanceApi,
  claimDeposit,
  closeFinanceApi,
  configureFinanceApiEnv,
  siweLogin,
} from "./helpers/finance-api-harness.js";
import { requireInfra } from "./helpers/infra.js";
import { startQuorumProxies } from "./helpers/quorum-proxy.js";

describe("production deposit monitor bounded sweep acceptance", () => {
  let prisma: ReturnType<typeof createPrismaClient>;
  let redis: Redis;
  let events: QueueEvents;
  let monitor: Awaited<ReturnType<typeof bootstrapCanonicalDepositMonitor>> | null = null;
  let assetId = "";
  const proxySets: Array<Awaited<ReturnType<typeof startQuorumProxies>>> = [];
  const treasury = getAccount(0).address.toLowerCase() as Address;
  const account = getAccount(12);

  beforeAll(async () => {
    const infra = requireInfra();
    configureFinanceApiEnv(infra);
    prisma = createPrismaClient();
    await resolveAllOpenIncidents(prisma);
    redis = new Redis(infra.redisUrl, { maxRetriesPerRequest: null });
    events = new QueueEvents("canonical-deposit-monitor", { connection: redis });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    if (monitor) {
      await monitor.queue.removeJobScheduler("canonical-deposit-monitor-singleton");
      await monitor.worker.close();
      await monitor.queue.close();
    }
    // The sweep cursor is shared Redis state: never leak it into other files.
    await redis?.del(CANONICAL_DEPOSIT_MONITOR_CURSOR_KEY).catch(() => undefined);
    await events?.close();
    await redis?.quit();
    if (prisma) {
      if (assetId) {
        await prisma.asset.updateMany({ where: { id: assetId }, data: { status: "FROZEN" } });
      }
      await resolveAllOpenIncidents(prisma);
      await closeFinanceApi();
      await prisma.$disconnect();
    }
    await Promise.all(proxySets.map((proxies) => proxies.close()));
  });

  it("checks every credited claim past the page boundary and re-checks them after the sweep wraps", async () => {
    const { chainA } = await attachTwoChainAnvil();
    const token = await deployMockAssetToken(chainA, "sweep", 6);
    const decimals = await readTokenDecimals(chainA, token.address);
    const proxies = await startQuorumProxies(chainA.rpcUrl, 2);
    proxySets.push(proxies);
    assetId = `eip155:${chainA.chain.id}/erc20:${token.address.toLowerCase()}`;
    await createAssetFixture(prisma, {
      assetId,
      chainId: chainA.chain.id,
      tokenAddress: token.address,
      symbol: token.symbol,
      decimals,
      treasuryAddress: treasury,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      confirmations: 1,
      // Far beyond the mined depth: the claims stay CREDITED and must keep
      // being monitored rather than being "completed away".
      deepFinality: 1000,
    });

    const app = await bootFinanceApi();
    const wallet = await siweLogin(app, account);
    const unit = 10n ** BigInt(decimals);
    await mintToken(chainA, token.address, account.address, 10n * unit);

    // All real transfers first, then mine before claiming. Credit-time
    // confirmations become a stable baseline that a starved claim never
    // advances past (the verifier's registry caches block numbers briefly, so
    // claiming immediately after a transfer can read a stale head).
    const transfers: Array<{ txHash: string; logIndex: number }> = [];
    for (let index = 0; index < 3; index++) {
      const receipt = await transferToken(chainA, token.address, 12, treasury, unit);
      const [log] = findTransferLogs(receipt, token.address, {
        from: account.address,
        to: treasury,
      });
      transfers.push({ txHash: log.txHash, logIndex: log.logIndex });
    }
    await mine(chainA, 3);

    const claims: Array<{ id: string; creditedConfirmations: number }> = [];
    for (const transfer of transfers) {
      const response = await claimDeposit(app, wallet, {
        assetId,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
      });
      expect(response.status, response.raw).toBe(201);
      const row = await prisma.depositClaimRecord.findUniqueOrThrow({
        where: { id: response.body.id },
      });
      expect(row.status).toBe("CREDITED");
      claims.push({ id: row.id, creditedConfirmations: row.confirmations });
    }

    // Advance the real chain after credit. A claim that is never swept keeps
    // the confirmations it was credited with; no further mining happens until
    // after the sweep has caught up, so the expected depth is exact.
    await mine(chainA, 5);
    const expected = claims.map((claim) => claim.creditedConfirmations + 5);

    // Production Redis-backed cursor, bounded to two claims per pass.
    await redis.del(CANONICAL_DEPOSIT_MONITOR_CURSOR_KEY);
    monitor = await bootstrapCanonicalDepositMonitor({
      prisma,
      redis,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      intervalMs: 60_000,
      limit: 2,
    });
    const pass = async () => {
      const job = await monitor!.queue.add(
        "canonical-deposit-monitor",
        {},
        { jobId: randomUUID() }
      );
      return job.waitUntilFinished(events, 30_000);
    };
    const confirmationsFor = async (id: string) =>
      (await prisma.depositClaimRecord.findUniqueOrThrow({ where: { id } })).confirmations;

    // Page one covers at most two claims; only a cursor sweep reaches the third.
    await expect
      .poll(
        async () => {
          await pass();
          const values = await Promise.all(claims.map((claim) => confirmationsFor(claim.id)));
          return values.every((value, index) => value === expected[index]);
        },
        { timeout: 30_000 }
      )
      .toBe(true);

    // The sweep wrapped. A further real head advance must be picked up again
    // for every credited claim, including records already deep in the set.
    await mine(chainA, 2);
    const advanced = expected.map((value) => value + 2);
    await expect
      .poll(
        async () => {
          await pass();
          const values = await Promise.all(claims.map((claim) => confirmationsFor(claim.id)));
          return values.every((value, index) => value === advanced[index]);
        },
        { timeout: 30_000 }
      )
      .toBe(true);

    // Monitoring is read-only: no reorg was fabricated and no credit moved.
    expect(await prisma.depositClaimRecord.count({ where: { assetId, status: "CREDITED" } })).toBe(
      3
    );
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: assetId } })).status).toBe(
      "ACTIVE"
    );
  });
});
