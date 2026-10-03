/** Real public claims, both chains/decimals, and the production BullMQ monitor.
 * Database writes configure assets or deliberately damage a projection to test
 * rebuild; they never fabricate deposits, journals, confirmations or reorgs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import type { Address, Hex } from "viem";
import { AtomicLedger } from "../../../api/src/finance-core.js";
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";
import { bootstrapCanonicalDepositMonitor } from "../../../api/src/workers/canonical-deposit-monitor.js";
import {
  attachTwoChainAnvil,
  batchTransferFrom,
  deployMockAssetToken,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  readTokenDecimals,
  revertSnapshot,
  safeHex,
  snapshot,
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
import { buildCustodyHarness } from "./helpers/custody-harness.js";
import { bootstrapOperator, resolveIncident } from "./helpers/finance-api-harness.js";
import { ANVIL_PUBLIC_PRIVATE_KEY } from "../fixtures/anvil-public-key.js";

describe("production deposit monitor and multi-chain journal acceptance", () => {
  let prisma: ReturnType<typeof createPrismaClient>;
  let redis: Redis;
  let events: QueueEvents;
  let monitor: Awaited<ReturnType<typeof bootstrapCanonicalDepositMonitor>>;
  const assets: string[] = [];
  const proxySets: Array<Awaited<ReturnType<typeof startQuorumProxies>>> = [];
  const treasury = getAccount(0).address.toLowerCase() as Address;
  const account = getAccount(11);

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
    await events?.close();
    await redis?.quit();
    if (prisma) {
      await prisma.asset.updateMany({ where: { id: { in: assets } }, data: { status: "FROZEN" } });
      await resolveAllOpenIncidents(prisma);
      await closeFinanceApi();
      await prisma.$disconnect();
    }
    await Promise.all(proxySets.map((proxies) => proxies.close()));
  });

  it("credits both real chains and same-transaction logs, rebuilds raw postings, and detects a real deposit reorg", async () => {
    const { chainA, chainB } = await attachTwoChainAnvil();
    const credited: Array<{ id: string; assetId: string; amount: bigint; journalId: string }> = [];
    let reorgSnapshot = "";
    let reorgReceipt: Awaited<ReturnType<typeof transferToken>>;
    let chainBToken: Awaited<ReturnType<typeof deployMockAssetToken>>;
    const routes = [];
    for (const [chain, decimals] of [
      [chainA, 6],
      [chainB, 18],
    ] as const) {
      const token = await deployMockAssetToken(chain, `truth${decimals}`, decimals);
      const actualDecimals = await readTokenDecimals(chain, token.address);
      expect(actualDecimals).toBe(decimals);
      const proxies = await startQuorumProxies(chain.rpcUrl, 2);
      proxySets.push(proxies);
      const assetId = `eip155:${chain.chain.id}/erc20:${token.address.toLowerCase()}`;
      assets.push(assetId);
      await createAssetFixture(prisma, {
        assetId,
        chainId: chain.chain.id,
        tokenAddress: token.address,
        symbol: token.symbol,
        decimals: actualDecimals,
        treasuryAddress: treasury,
        rpcUrls: proxies.proxies.map((proxy) => proxy.url),
        confirmations: 1,
        deepFinality: 3,
      });
      routes.push({ chain, decimals, token, assetId });
    }
    const app = await bootFinanceApi();
    const wallet = await siweLogin(app, account);
    for (const { chain, decimals, token, assetId } of routes) {
      const unit = 10n ** BigInt(decimals);
      await mintToken(chain, token.address, account.address, 10n * unit);
      if (chain === chainA) reorgSnapshot = await snapshot(chain);
      const receipt =
        chain === chainA
          ? await transferToken(chain, token.address, 11, treasury, 2n * unit)
          : await batchTransferFrom(
              chain,
              token.address,
              11,
              [treasury, treasury],
              [unit, 2n * unit]
            );
      if (chain === chainA) reorgReceipt = receipt;
      else chainBToken = token;
      const logs = findTransferLogs(receipt, token.address, {
        from: account.address,
        to: treasury,
      });
      expect(logs).toHaveLength(chain === chainA ? 1 : 2);
      if (chain === chainB) {
        expect(logs[0].txHash).toBe(logs[1].txHash);
        expect(logs[0].logIndex).not.toBe(logs[1].logIndex);
      }
      await mine(chain, 3);
      for (const log of logs) {
        const response = await claimDeposit(app, wallet, {
          assetId,
          txHash: log.txHash,
          logIndex: log.logIndex,
        });
        expect(response.status, response.raw).toBe(201);
        expect(response.body.amountAtomic).toBe(log.value.toString());
        const row = await prisma.depositClaimRecord.findUniqueOrThrow({
          where: { id: response.body.id },
        });
        expect(row.chainId).toBe(chain.chain.id);
        expect(row.txHash).toBe(receipt.transactionHash);
        expect(row.logIndex).toBe(log.logIndex);
        credited.push({
          id: row.id,
          assetId,
          amount: log.value,
          journalId: row.creditedJournalId!,
        });
        const duplicate = await claimDeposit(app, wallet, {
          assetId,
          txHash: log.txHash,
          logIndex: log.logIndex,
        });
        expect(duplicate.status, duplicate.raw).toBe(200);
        expect(duplicate.body.id).toBe(row.id);
      }
    }

    const postings = await prisma.journalPosting.findMany({
      where: { assetId: { in: assets } },
      include: { account: true },
    });
    const sums = new Map<string, bigint>();
    for (const posting of postings)
      sums.set(
        posting.accountId,
        (sums.get(posting.accountId) ?? 0n) + BigInt(posting.amountAtomic)
      );
    for (const credit of credited) {
      const entries = postings.filter((posting) => posting.transactionId === credit.journalId);
      expect(entries).toHaveLength(2);
      expect(entries.reduce((sum, posting) => sum + BigInt(posting.amountAtomic), 0n)).toBe(0n);
      expect(
        entries.find((posting) => posting.account.class === "USER_AVAILABLE")?.amountAtomic
      ).toBe(credit.amount.toString());
    }
    const accounts = await prisma.atomicAccount.findMany({ where: { assetId: { in: assets } } });
    for (const row of accounts) expect(BigInt(row.balanceAtomic)).toBe(sums.get(row.id));
    // Deliberate projection corruption, NOT a fabricated opening credit.
    await prisma.atomicAccount.update({
      where: { id: accounts[0].id },
      data: { balanceAtomic: "999" },
    });
    const ledger = new AtomicLedger(prisma);
    expect((await ledger.rebuild()).changed).toBe(1);
    for (const row of await prisma.atomicAccount.findMany({ where: { assetId: { in: assets } } }))
      expect(BigInt(row.balanceAtomic)).toBe(sums.get(row.id));
    expect((await ledger.rebuild()).changed).toBe(0);

    monitor = await bootstrapCanonicalDepositMonitor({
      prisma,
      redis,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      intervalMs: 60_000,
    });
    async function pass() {
      const job = await monitor.queue.add("canonical-deposit-monitor", {}, { jobId: randomUUID() });
      return job.waitUntilFinished(events, 30_000);
    }
    await expect
      .poll(async () => {
        await pass();
        return (
          await prisma.depositClaimRecord.findUniqueOrThrow({ where: { id: credited[0].id } })
        ).confirmations;
      })
      .toBeGreaterThanOrEqual(3);
    const journalCount = await prisma.journalTransaction.count({ where: { assetId: assets[0] } });
    await revertSnapshot(chainA, safeHex(reorgSnapshot, "reorg snapshot id"));
    await mine(chainA, 5);
    expect(
      await chainA.publicClient
        .getTransactionReceipt({ hash: reorgReceipt!.transactionHash })
        .catch(() => null)
    ).toBeNull();
    const replacement = await chainA.publicClient.getBlock({
      blockNumber: reorgReceipt!.blockNumber,
    });
    expect(replacement.hash).not.toBe(reorgReceipt!.blockHash);
    await expect
      .poll(
        async () => {
          await pass();
          return (
            await prisma.depositClaimRecord.findUniqueOrThrow({ where: { id: credited[0].id } })
          ).status;
        },
        { timeout: 15_000 }
      )
      .toBe("ORPHANED");
    await pass();
    expect(await prisma.journalTransaction.count({ where: { assetId: assets[0] } })).toBe(
      journalCount
    );
    expect(
      (
        await prisma.atomicAccount.findFirstOrThrow({
          where: { assetId: assets[0], ownerId: wallet.principalId, class: "USER_AVAILABLE" },
        })
      ).balanceAtomic
    ).toBe(credited[0].amount.toString());
    expect(
      await prisma.financialIncident.count({ where: { assetId: assets[0], kind: "DEPOSIT_REORG" } })
    ).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: assets[0] } })).status).toBe(
      "FROZEN"
    );

    const custodyB = buildCustodyHarness({
      prisma,
      databaseUrl: requireInfra().databaseUrl,
      chainId: chainB.chain.id,
      tokenAddress: chainBToken!.address,
      treasuryAddress: treasury,
      treasuryPrivateKey: ANVIL_PUBLIC_PRIVATE_KEY,
      rpcUrls: proxySets[1].proxies.map((proxy) => proxy.url),
      quorumThreshold: 2,
    });
    expect((await custodyB.workflow.reconcileAsset(assets[1])).mismatch).toBe(false);

    // Conflicting real JSON-RPC block responses on B must persist a freeze,
    // reject the public claim, and leave its journal/projection untouched.
    const receipt = await transferToken(chainB, chainBToken!.address, 11, treasury, 10n ** 18n);
    const [log] = findTransferLogs(receipt, chainBToken!.address, { to: treasury });
    proxySets[1].proxies[1].state.blockHashOverride = new Map<string, Hex>([
      [`0x${receipt.blockNumber.toString(16)}`, `0x${"ab".repeat(32)}`],
    ]);
    const before = await prisma.journalTransaction.count({ where: { assetId: assets[1] } });
    const rejected = await claimDeposit(app, wallet, {
      assetId: assets[1],
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(rejected.status, rejected.raw).toBe(503);
    expect(await prisma.journalTransaction.count({ where: { assetId: assets[1] } })).toBe(before);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: assets[1] } })).status).toBe(
      "FROZEN"
    );
    expect(
      await prisma.financialIncident.count({
        where: { chainId: chainB.chain.id, kind: "RPC_DISAGREEMENT", status: "OPEN" },
      })
    ).toBeGreaterThan(0);
    proxySets[1].proxies[1].state.blockHashOverride = undefined;
    const incident = await prisma.financialIncident.findFirstOrThrow({
      where: { chainId: chainB.chain.id, assetId: null, kind: "RPC_DISAGREEMENT", status: "OPEN" },
    });
    const operator = await bootstrapOperator(app, getAccount(70));
    // The recent MATCHED row predates an uncredited real transfer. A chain-wide
    // resolver must check every live asset, not just a responding block-height.
    const denied = await resolveIncident(app, operator, incident.id, { note: "changed backing" });
    expect(denied.status, denied.raw).toBe(503);
    expect((denied.body as { code: string }).code).toBe("RECONCILIATION_UNVERIFIED");
    await transferToken(chainB, chainBToken!.address, 0, getAccount(70).address, 10n ** 18n);
    expect((await custodyB.workflow.reconcileAsset(assets[1])).mismatch).toBe(false);
    const resolved = await resolveIncident(app, operator, incident.id, {
      note: "fresh real backing and ledger verified",
    });
    expect(resolved.status, resolved.raw).toBe(200);
    expect(
      (await prisma.financialIncident.findUniqueOrThrow({ where: { id: incident.id } })).version
    ).toBe(incident.version + 1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: assets[1] } })).status).toBe(
      "ACTIVE"
    );
    const resumedReceipt = await transferToken(
      chainB,
      chainBToken!.address,
      11,
      treasury,
      10n ** 18n
    );
    const [resumedLog] = findTransferLogs(resumedReceipt, chainBToken!.address, { to: treasury });
    const resumed = await claimDeposit(app, wallet, {
      assetId: assets[1],
      txHash: resumedLog.txHash,
      logIndex: resumedLog.logIndex,
    });
    expect(resumed.status, resumed.raw).toBe(201);
    expect(resumed.body.amountAtomic).toBe((10n ** 18n).toString());
  });
});
