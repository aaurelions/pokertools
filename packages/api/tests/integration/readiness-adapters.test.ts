import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { ReadinessResponseSchema } from "@pokertools/types";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";
import { FinancialIncidentService } from "../../src/services/financial-incidents.js";
import {
  buildReadinessResponse,
  createAtomicLedgerReadinessProbe,
  createChainRegistryReadinessProbe,
  createDurableCustodyEvidenceProbe,
  createPlatformReadiness,
  createQueueHealthProbe,
  createRedisHealthProbe,
  hasConfiguredCanonicalAsset,
  type CustodyHeartbeatRecord,
  type PlatformReadinessApp,
} from "../../src/services/readiness-adapters.js";

/**
 * Adapter tests run against an isolated copy of the SQLite test database with
 * real AtomicLedger / ChainRegistry / FinancialIncidentService code. External
 * I/O (RPC transports, Redis, BullMQ, custody worker) is injected, never
 * assumed healthy.
 */

let prisma: PrismaClient;
let tempRoot: string;

const CHAIN_A = 31337;
const CHAIN_B = 31338;
const TREASURY = "0x00000000000000000000000000000000000000aa";

function canonicalAssetId(chainId: number, token: string): string {
  return `eip155:${chainId}/erc20:${token.toLowerCase()}`;
}

async function createAsset(
  overrides: {
    id?: string;
    chainId?: number;
    tokenAddress?: string;
    status?: "ACTIVE" | "DEGRADED" | "FROZEN";
    rpcUrls?: unknown;
  } = {}
) {
  const chainId = overrides.chainId ?? CHAIN_A;
  const tokenAddress = (
    overrides.tokenAddress ?? "0x0000000000000000000000000000000000000001"
  ).toLowerCase();
  return prisma.asset.create({
    data: {
      id: overrides.id ?? canonicalAssetId(chainId, tokenAddress),
      chainId,
      tokenAddress,
      symbol: "TST",
      decimals: 18,
      status: overrides.status ?? "ACTIVE",
      confirmations: 1,
      deepFinality: 2,
      treasuryAddress: TREASURY,
      rpcUrls: (overrides.rpcUrls ?? ["https://rpc-a.test", "https://rpc-b.test"]) as never,
      minGasAtomic: "1000000000000000000",
    },
  });
}

async function createUnbalancedAccount(assetId: string): Promise<void> {
  await prisma.atomicAccount.create({
    data: {
      assetId,
      ownerId: null,
      ownerKey: "@system",
      class: "TREASURY_RESERVE",
      balanceAtomic: "5",
      version: 0,
    },
  });
}

// --- Fake RPC clients (injected through ChainRegistryOptions.createClient) ---

function makeRpcFactory(options: { disagreeOnBlockHash?: boolean } = {}) {
  return (endpoint: { id: string; chainId: number; url: string }) => ({
    async getChainId() {
      return BigInt(endpoint.chainId);
    },
    async getBlockNumber() {
      return 100n;
    },
    async getBlock() {
      return {
        number: 100n,
        hash: options.disagreeOnBlockHash
          ? `0x${endpoint.id.endsWith("0") ? "a".repeat(64) : "b".repeat(64)}`
          : `0x${"c".repeat(64)}`,
        parentHash: `0x${"d".repeat(64)}`,
      };
    },
    async getTransactionReceipt() {
      return null;
    },
    async getBalance() {
      return 10n;
    },
    async getTokenBalance() {
      return 20n;
    },
  });
}

const resolveDistinctHost: (hostname: string) => Promise<string[]> = async (hostname) => [hostname];

function makeApp(overrides: Partial<PlatformReadinessApp> = {}): PlatformReadinessApp {
  return {
    prisma,
    redis: { ping: async () => "PONG" },
    queue: { getJobCounts: async () => ({ failed: 0, waiting: 0 }) },
    ...overrides,
  };
}

beforeAll(() => {
  const sourcePath = (process.env.DATABASE_URL ?? "").replace(/^file:/, "");
  tempRoot = mkdtempSync(join(tmpdir(), "pokertools-readiness-adapters-"));
  const isolatedPath = join(tempRoot, "adapters.db");
  copyFileSync(sourcePath, isolatedPath);
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${isolatedPath}` }) });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const model of [
    prisma.gameEvent,
    prisma.gameOutbox,
    prisma.treasuryReconciliation,
    prisma.depositClaimRecord,
    prisma.withdrawalIntentRecord,
    prisma.journalPosting,
    prisma.journalTransaction,
    prisma.atomicAccount,
    prisma.financialIncident,
    prisma.asset,
    prisma.table,
  ]) {
    await model.deleteMany();
  }
});

describe("readiness-adapters", () => {
  it("maps an internal report to the wire ReadinessResponse contract", () => {
    const notReady = buildReadinessResponse({
      state: "BLOCKED",
      ready: false,
      timestamp: 42,
      checks: [
        {
          name: "redis",
          state: "BLOCKED",
          mandatory: true,
          latencyMs: 1,
          detail: "REDIS_UNREACHABLE",
        },
      ],
      financial: {
        state: "NOT_READY",
        reasons: ["ASSET_LEDGER_UNVERIFIED"],
        checks: [{ name: "ledger", state: "NOT_READY", latencyMs: 1, detail: "LEDGER_OK" }],
      },
    });
    expect(notReady.status).toBe("not_ready");
    expect(ReadinessResponseSchema.safeParse(notReady).success).toBe(true);

    const ready = buildReadinessResponse({
      state: "READY",
      ready: true,
      timestamp: 43,
      checks: [
        {
          name: "redis",
          state: "READY",
          mandatory: true,
          latencyMs: 1,
          detail: "REDIS_OK",
        },
      ],
      financial: { state: "READY", reasons: [], checks: [] },
    });
    expect(ready.status).toBe("ready");
    expect(ReadinessResponseSchema.safeParse(ready).success).toBe(true);
  });

  it("reports Redis reachability without assuming healthy", async () => {
    expect((await createRedisHealthProbe({ ping: async () => "PONG" }).check()).ok).toBe(true);
    const down = await createRedisHealthProbe({
      ping: async () => Promise.reject(new Error("redis://user:secret@host")),
    }).check();
    expect(down.ok).toBe(false);
    expect(down.code).toBe("REDIS_UNREACHABLE");
    expect(JSON.stringify(down)).not.toContain("secret");
  });

  it("reports BullMQ backlog health without assuming healthy", async () => {
    expect(
      (
        await createQueueHealthProbe({
          getJobCounts: async () => ({ failed: 0, waiting: 3 }),
        }).check()
      ).ok
    ).toBe(true);
    const backlog = await createQueueHealthProbe({
      getJobCounts: async () => ({ failed: 500, waiting: 1 }),
    }).check();
    expect(backlog.ok).toBe(false);
    expect(backlog.code).toBe("QUEUE_FAILED_BACKLOG");
  });

  it("inspects real ledger invariants and projections through AtomicLedger", async () => {
    const asset = await createAsset();
    const ledger = new AtomicLedger(prisma);
    const probe = createAtomicLedgerReadinessProbe(prisma, ledger);

    // Empty journal is balanced.
    expect(await probe.verify()).toEqual({ ok: true, code: "LEDGER_OK" });

    // A real balanced posting passes.
    const left = await prisma.atomicAccount.create({
      data: { assetId: asset.id, ownerKey: "@l", class: "TREASURY_RESERVE", balanceAtomic: "0" },
    });
    const right = await prisma.atomicAccount.create({
      data: { assetId: asset.id, ownerKey: "@r", class: "INCIDENT_OBLIGATION", balanceAtomic: "0" },
    });
    await ledger.postAtomic({
      assetId: asset.id,
      requestId: `req-${asset.id}`,
      postings: [
        { accountId: left.id, amountAtomic: "5" },
        { accountId: right.id, amountAtomic: "-5" },
      ],
    });
    expect(await probe.verify()).toEqual({ ok: true, code: "LEDGER_OK" });

    // A drifted projection fails closed without rebuilding.
    await prisma.atomicAccount.update({
      where: { id: left.id },
      data: { balanceAtomic: "6" },
    });
    expect(await probe.verify()).toEqual({ ok: false, code: "LEDGER_INVARIANT_FAILURE" });
  });

  it("validates RPC topology and reads settlement/block/custody quorum", async () => {
    await createAsset({ rpcUrls: ["https://rpc-a.test", "https://rpc-b.test"] });
    const incidents = new FinancialIncidentService(prisma, new AtomicLedger(prisma));
    const probe = createChainRegistryReadinessProbe({
      prisma,
      incidents,
      createClient: makeRpcFactory() as never,
      resolveHost: resolveDistinctHost,
    });

    const result = await probe.verifyQuorum();
    expect(result.ok).toBe(true);
    expect(result.code).toBe("RPC_QUORUM_OK");
    expect(result.chainsChecked).toBe(1);
  });

  it("treats a URL pool repeated across same-chain assets as one participant set", async () => {
    const urls = ["https://pool-a.test", "https://pool-b.test"];
    await createAsset({
      tokenAddress: "0x0000000000000000000000000000000000000001",
      rpcUrls: urls,
    });
    await createAsset({
      tokenAddress: "0x0000000000000000000000000000000000000002",
      rpcUrls: urls,
    });
    const incidents = new FinancialIncidentService(prisma, new AtomicLedger(prisma));
    const probe = createChainRegistryReadinessProbe({
      prisma,
      incidents,
      createClient: makeRpcFactory() as never,
      resolveHost: resolveDistinctHost,
    });

    expect((await probe.verifyQuorum()).ok).toBe(true);

    // A genuine single-participant pool fails closed.
    await prisma.asset.deleteMany();
    await createAsset({ rpcUrls: ["https://only-one.test"] });
    const single = createChainRegistryReadinessProbe({
      prisma,
      incidents,
      createClient: makeRpcFactory() as never,
      resolveHost: resolveDistinctHost,
    });
    const result = await single.verifyQuorum();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RPC_ENDPOINT_INVALID");
  });

  it("durably records RPC disagreement and freezes the route via the incident service", async () => {
    const asset = await createAsset({ rpcUrls: ["https://rpc-a.test", "https://rpc-b.test"] });
    const incidents = new FinancialIncidentService(prisma, new AtomicLedger(prisma));
    const probe = createChainRegistryReadinessProbe({
      prisma,
      incidents,
      createClient: makeRpcFactory({ disagreeOnBlockHash: true }) as never,
      resolveHost: resolveDistinctHost,
    });

    const result = await probe.verifyQuorum();
    expect(result).toEqual({ ok: false, code: "RPC_DISAGREEMENT" });

    const disagreement = await prisma.financialIncident.findFirst({
      where: { kind: "RPC_DISAGREEMENT", chainId: CHAIN_A },
    });
    expect(disagreement).not.toBeNull();
    const freeze = await prisma.financialIncident.findFirst({
      where: { kind: "CUSTODY_FAILURE", chainId: CHAIN_A },
    });
    expect(freeze).not.toBeNull();
    expect((freeze?.evidence as { routeFreeze?: boolean }).routeFreeze).toBe(true);

    const frozen = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(frozen.status).toBe("FROZEN");
  });

  it("fails custody closed without durable worker evidence and never infers from reconciliation", async () => {
    const asset = await createAsset();
    const defaultProbe = createDurableCustodyEvidenceProbe({ prisma });
    const missing = await defaultProbe.checkReadiness();
    expect(missing.ready).toBe(false);
    expect(missing.code).toBe("CUSTODY_EVIDENCE_MISSING");

    // A matched reconciliation is not signer evidence.
    await prisma.treasuryReconciliation.create({
      data: {
        assetId: asset.id,
        chainId: CHAIN_A,
        observedAtomic: "0",
        ledgerAtomic: "0",
        differenceAtomic: "0",
        blockNumber: "1",
        status: "MATCHED",
        evidence: { source: "test" },
      },
    });
    const stillMissing = await defaultProbe.checkReadiness();
    expect(stillMissing.ready).toBe(false);
    expect(stillMissing.code).toBe("CUSTODY_EVIDENCE_MISSING");
  });

  it("accepts only fresh durable signer/gas heartbeats", async () => {
    const [assetA, assetB] = await Promise.all([
      createAsset({ chainId: CHAIN_A, tokenAddress: "0x0000000000000000000000000000000000000001" }),
      createAsset({ chainId: CHAIN_B, tokenAddress: "0x0000000000000000000000000000000000000002" }),
    ]);
    void assetA;

    const healthy: CustodyHeartbeatRecord[] = [
      {
        chainId: CHAIN_A,
        signerAddress: TREASURY,
        signerReady: true,
        gasReady: true,
        observedAt: new Date(),
        workerId: "w1",
      },
      {
        chainId: CHAIN_B,
        signerAddress: TREASURY,
        signerReady: true,
        gasReady: true,
        observedAt: new Date(),
        workerId: "w1",
      },
    ];
    const readyProbe = createDurableCustodyEvidenceProbe({
      prisma,
      reader: { read: async () => healthy },
    });
    expect(await readyProbe.checkReadiness()).toEqual({
      ready: true,
      gasReady: true,
      code: "CUSTODY_READY",
    });

    const gasStarved = createDurableCustodyEvidenceProbe({
      prisma,
      reader: {
        read: async () =>
          healthy.map((heartbeat) => ({ ...heartbeat, gasReady: heartbeat.chainId === CHAIN_A })),
      },
    });
    expect(await gasStarved.checkReadiness()).toEqual({
      ready: true,
      gasReady: false,
      code: "CUSTODY_READY",
      gasCode: "NATIVE_GAS_LOW",
    });

    const stale = createDurableCustodyEvidenceProbe({
      prisma,
      maxAgeMs: 1_000,
      reader: {
        read: async () =>
          healthy.map((heartbeat) => ({
            ...heartbeat,
            observedAt: new Date(Date.now() - 60_000),
          })),
      },
    });
    expect((await stale.checkReadiness()).code).toBe("CUSTODY_HEARTBEAT_MISSING");
    void assetB;
  });

  it("detects canonical configured assets for payout gating", async () => {
    await createAsset({
      id: "legacy-usdc",
      tokenAddress: "0x0000000000000000000000000000000000000009",
    });
    expect(await hasConfiguredCanonicalAsset(prisma)).toBe(false);
    await prisma.asset.deleteMany();
    await createAsset();
    expect(await hasConfiguredCanonicalAsset(prisma)).toBe(true);
  });

  it("enables payouts from configured assets and blocks on absent custody evidence", async () => {
    await createAsset();
    const service = createPlatformReadiness(makeApp(), {
      publicNonFinancialMode: false,
      chainQuorum: { verifyQuorum: async () => ({ ok: true, code: "RPC_QUORUM_OK" }) },
    });

    const report = await service.evaluate();
    const custody = report.checks.find((check) => check.name === "custody");
    expect(custody?.state).toBe("BLOCKED");
    expect(custody?.detail).toBe("CUSTODY_EVIDENCE_MISSING");
    // Reachable RPC endpoints cannot substitute for a live signing worker.
    expect(report.ready).toBe(false);
    expect(buildReadinessResponse(report).status).toBe("not_ready");
  });

  it("disables payout/custody gating only in explicit public non-financial mode", async () => {
    await createAsset();
    const service = createPlatformReadiness(makeApp(), {
      publicNonFinancialMode: true,
      chainQuorum: { verifyQuorum: async () => ({ ok: true, code: "RPC_QUORUM_OK" }) },
    });

    const report = await service.evaluate();
    const custody = report.checks.find((check) => check.name === "custody");
    expect(custody?.state).toBe("READY");
    expect(custody?.detail).toBe("PAYOUTS_DISABLED");
  });

  it("expires readiness on monotonic time even when wall time moves backward", async () => {
    let calls = 0;
    let now = Date.now();
    let elapsed = 0;
    const service = createPlatformReadiness(makeApp(), {
      now: () => now,
      elapsedNow: () => elapsed,
      cacheTtlMs: 50,
      rpcQuorumRequired: true,
      chainQuorum: {
        verifyQuorum: async () => {
          calls += 1;
          return { ok: true, code: "RPC_QUORUM_OK" };
        },
      },
    });

    const first = await service.evaluate();
    const second = await service.evaluate();
    expect(second).toBe(first);
    expect(calls).toBe(1);

    now -= 60 * 60_000;
    elapsed += 60;
    const third = await service.evaluate();
    expect(third).not.toBe(first);
    expect(calls).toBe(2);
  });
});
