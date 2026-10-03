import { describe, it, expect, vi } from "vitest";
import {
  runCanonicalDepositMonitorOnce,
  type CanonicalDepositMonitorDeps,
  type DepositMonitorCursorStore,
  type MonitorRegistry,
} from "../../src/workers/canonical-deposit-monitor.js";
import {
  ChainFrozenError,
  type CanonicalReceipt,
  type NormalizedBlock,
  type NormalizedReceipt,
} from "../../src/services/chain-registry.js";

const CHAIN_ID = 31337;
const ASSET_ID = "eip155:31337/erc20:0x1111111111111111111111111111111111111111";
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"ef".repeat(32)}`;
const TX = `0x${"ab".repeat(32)}`;

interface ClaimSeed {
  id: string;
  assetId: string;
  blockNumber: string | null;
  blockHash: string | null;
  confirmations: number;
  status: string;
}

function makeDeps(options: {
  claim: ClaimSeed;
  deepFinality?: number;
  head?: bigint;
  block?: NormalizedBlock;
  blockError?: Error;
}) {
  const recordDepositReorg = vi.fn(async () => ({ claim: {}, incident: {} }));
  const freezeAsset = vi.fn(async () => undefined);
  const freezeChain = vi.fn(async () => undefined);
  const update = vi.fn(async () => ({}));

  const prisma = {
    depositClaimRecord: {
      findMany: vi.fn(async () => [options.claim]),
      update,
    },
    asset: {
      findUnique: vi.fn(async () => ({
        id: ASSET_ID,
        chainId: CHAIN_ID,
        deepFinality: options.deepFinality ?? 50,
      })),
    },
  };

  const registry: MonitorRegistry = {
    getSettlementBlockNumber: vi.fn(async () => options.head ?? 120n),
    getBlock: vi.fn(async () => {
      if (options.blockError) throw options.blockError;
      return (
        options.block ?? { number: 100n, hash: BLOCK_HASH, parentHash: `0x${"01".repeat(32)}` }
      );
    }),
    getTransactionReceipt: vi.fn(async () => null as NormalizedReceipt | null),
    getBlockNumber: vi.fn(async () => options.head ?? 120n),
    getBalance: vi.fn(async () => 0n),
    getTokenBalance: vi.fn(async () => 0n),
    getCanonicalReceipt: vi.fn(async () => null as CanonicalReceipt | null),
    isChainAuthorized: vi.fn(() => true),
    freezeChain,
  };

  const deps = {
    prisma,
    registry,
    intents: { recordDepositReorg },
    incidents: { freezeAsset },
  } as unknown as CanonicalDepositMonitorDeps;

  return { deps, recordDepositReorg, freezeAsset, freezeChain, update };
}

function baseClaim(overrides: Partial<ClaimSeed> = {}): ClaimSeed {
  return {
    id: "claim_1",
    assetId: ASSET_ID,
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    confirmations: 10,
    status: "CREDITED",
    ...overrides,
  };
}

/** Credited claims with unique block numbers so `getBlock` calls are traceable. */
function sweepClaims(prefix: string, count: number): ClaimSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${index + 1}`,
    assetId: ASSET_ID,
    blockNumber: String(100 + index),
    blockHash: BLOCK_HASH,
    confirmations: 1,
    status: "CREDITED",
  }));
}

/**
 * Keyset-aware Prisma/registry doubles for sweep tests. Each harness owns a
 * distinct `prisma` object, which is exactly what scopes the in-process cursor.
 */
function makeSweepHarness(options: {
  claims: ClaimSeed[];
  limit: number;
  cursorStore?: DepositMonitorCursorStore;
  deepFinality?: number;
}) {
  const findMany = vi.fn(
    async (args: { where?: { id?: { gt?: string } }; take?: number }): Promise<ClaimSeed[]> => {
      const gt = args.where?.id?.gt;
      return options.claims
        .filter((claim) => claim.status === "CREDITED" && (gt === undefined || claim.id > gt))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take);
    }
  );
  const getBlock = vi.fn(async (_chainId: number, ref: { blockNumber: bigint }) => ({
    number: ref.blockNumber,
    hash: BLOCK_HASH,
    parentHash: `0x${"01".repeat(32)}`,
  }));
  const update = vi.fn(async (args: { where: { id: string }; data: { confirmations: number } }) => {
    const claim = options.claims.find((candidate) => candidate.id === args.where.id);
    if (claim) claim.confirmations = args.data.confirmations;
    return {};
  });
  const registry: MonitorRegistry = {
    getSettlementBlockNumber: vi.fn(async () => 120n),
    getBlock,
    getTransactionReceipt: vi.fn(async () => null as NormalizedReceipt | null),
    getBlockNumber: vi.fn(async () => 120n),
    getBalance: vi.fn(async () => 0n),
    getTokenBalance: vi.fn(async () => 0n),
    getCanonicalReceipt: vi.fn(async () => null as CanonicalReceipt | null),
    isChainAuthorized: vi.fn(() => true),
    freezeChain: vi.fn(async () => undefined),
  };
  const deps = {
    prisma: {
      depositClaimRecord: { findMany, update },
      asset: {
        findUnique: vi.fn(async () => ({
          id: ASSET_ID,
          chainId: CHAIN_ID,
          // claim at block 100 with head 120 => 21 confirmations is deep final.
          deepFinality: options.deepFinality ?? 21,
        })),
      },
    },
    registry,
    intents: { recordDepositReorg: vi.fn(async () => ({ claim: {}, incident: {} })) },
    incidents: { freezeAsset: vi.fn(async () => undefined) },
    limit: options.limit,
    ...(options.cursorStore ? { cursorStore: options.cursorStore } : {}),
  } as unknown as CanonicalDepositMonitorDeps;
  return { deps, findMany, getBlock, update };
}

describe("runCanonicalDepositMonitorOnce", () => {
  it("advances confirmations and counts deep-final claims", async () => {
    const { deps, update, recordDepositReorg } = makeDeps({
      claim: baseClaim(),
      deepFinality: 50,
      head: 160n,
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({
      checked: 1,
      deepFinalized: 1,
      reorged: 0,
      preserved: 0,
      sweepComplete: true,
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "claim_1" }, data: { confirmations: 61 } });
    expect(recordDepositReorg).not.toHaveBeenCalled();
  });

  it("records a reorg, freezes the chain and freezes the asset without touching the credit", async () => {
    const { deps, recordDepositReorg, freezeAsset, freezeChain, update } = makeDeps({
      claim: baseClaim(),
      block: { number: 100n, hash: OTHER_BLOCK_HASH, parentHash: `0x${"01".repeat(32)}` },
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({
      checked: 1,
      deepFinalized: 0,
      reorged: 1,
      preserved: 0,
      sweepComplete: true,
    });
    expect(recordDepositReorg).toHaveBeenCalledTimes(1);
    expect(recordDepositReorg).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: "claim_1", blockNumber: "100" })
    );
    expect(freezeChain).toHaveBeenCalledWith(
      CHAIN_ID,
      expect.objectContaining({ method: "DEPOSIT_REORG", reason: "block_hash_mismatch" })
    );
    expect(freezeAsset).toHaveBeenCalledWith(ASSET_ID);
    // No confirmation update on the reorg path; journal/credit untouched.
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves the claim on quorum/lost-RPC failure instead of concluding a reorg", async () => {
    const { deps, recordDepositReorg, freezeChain } = makeDeps({
      claim: baseClaim(),
      blockError: new ChainFrozenError(CHAIN_ID),
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({
      checked: 1,
      deepFinalized: 0,
      reorged: 0,
      preserved: 1,
      sweepComplete: true,
    });
    expect(recordDepositReorg).not.toHaveBeenCalled();
    expect(freezeChain).not.toHaveBeenCalled();
  });

  it("preserves claims that have no stored block number", async () => {
    const { deps, recordDepositReorg } = makeDeps({
      claim: baseClaim({ blockNumber: null }),
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({
      checked: 1,
      deepFinalized: 0,
      reorged: 0,
      preserved: 1,
      sweepComplete: true,
    });
    expect(recordDepositReorg).not.toHaveBeenCalled();
  });

  it("sweeps every credited claim across bounded pages and wraps to deep-final records", async () => {
    const allClaims = sweepClaims("claim", 5);
    let cursor: string | null = null;
    const { deps, findMany, getBlock, update } = makeSweepHarness({
      claims: allClaims,
      limit: 2,
      cursorStore: {
        read: vi.fn(async () => cursor),
        write: vi.fn(async (next: string | null) => {
          cursor = next;
        }),
      },
    });

    const first = await runCanonicalDepositMonitorOnce(deps);
    const second = await runCanonicalDepositMonitorOnce(deps);
    const third = await runCanonicalDepositMonitorOnce(deps);
    const wrapped = await runCanonicalDepositMonitorOnce(deps);

    // Bounded pages: 2 + 2 + 1, then the sweep wraps.
    expect(first).toMatchObject({ checked: 2, sweepComplete: false });
    expect(second).toMatchObject({ checked: 2, sweepComplete: false });
    expect(third).toMatchObject({ checked: 1, sweepComplete: true });
    // Wrapped pass re-checks the OLDEST (already deep-final) claim first.
    expect(wrapped).toMatchObject({ checked: 2, sweepComplete: false, deepFinalized: 1 });

    const pages = findMany.mock.calls.map(([args]) => args);
    expect(pages[0].where).not.toHaveProperty("id");
    expect(pages[1].where).toMatchObject({ id: { gt: "claim_2" } });
    expect(pages[2].where).toMatchObject({ id: { gt: "claim_4" } });
    // After the wrap the cursor is cleared again.
    expect(pages[3].where).not.toHaveProperty("id");

    // Every credited claim, including the deep-final first one, was re-checked
    // on the wrapped pass; monitoring never stops at a depth/age horizon.
    const checkedBlocks = getBlock.mock.calls.map(([, ref]) => Number(ref.blockNumber));
    expect(checkedBlocks).toEqual([100, 101, 102, 103, 104, 100, 101]);
    // Confirmations were advanced exactly once per claim (idempotent re-check).
    expect(update).toHaveBeenCalledTimes(5);
  });

  it("keeps independent monitors' in-process cursors separate", async () => {
    const monitorA = makeSweepHarness({ claims: sweepClaims("a", 4), limit: 2 });
    const monitorB = makeSweepHarness({ claims: sweepClaims("b", 4), limit: 2 });

    // A advances to its second page...
    await runCanonicalDepositMonitorOnce(monitorA.deps);
    await runCanonicalDepositMonitorOnce(monitorA.deps);
    expect(monitorA.findMany.mock.calls[1][0].where).toMatchObject({ id: { gt: "a_2" } });

    // ...but B, with its own prisma/database, must still start at page one.
    const firstB = await runCanonicalDepositMonitorOnce(monitorB.deps);
    expect(firstB).toMatchObject({ checked: 2, sweepComplete: false });
    const bPages = monitorB.findMany.mock.calls.map(([args]) => args);
    expect(bPages[0].where).not.toHaveProperty("id");
    expect(monitorB.getBlock.mock.calls.map(([, ref]) => Number(ref.blockNumber))).toEqual([
      100, 101,
    ]);
  });

  it("continues the full sweep and wrap when the durable cursor store always fails", async () => {
    const allClaims = sweepClaims("claim", 5);
    const failingStore: DepositMonitorCursorStore = {
      read: vi.fn(async () => {
        throw new Error("redis read unavailable");
      }),
      write: vi.fn(async () => {
        throw new Error("redis write unavailable");
      }),
    };
    const { deps, findMany, getBlock, update } = makeSweepHarness({
      claims: allClaims,
      limit: 2,
      cursorStore: failingStore,
    });

    const first = await runCanonicalDepositMonitorOnce(deps);
    const second = await runCanonicalDepositMonitorOnce(deps);
    const third = await runCanonicalDepositMonitorOnce(deps);
    const wrapped = await runCanonicalDepositMonitorOnce(deps);

    // A Redis outage must never rewind the in-memory sweep: 2 + 2 + 1, wrap.
    expect(first).toMatchObject({ checked: 2, sweepComplete: false });
    expect(second).toMatchObject({ checked: 2, sweepComplete: false });
    expect(third).toMatchObject({ checked: 1, sweepComplete: true });
    expect(wrapped).toMatchObject({ checked: 2, sweepComplete: false, deepFinalized: 1 });

    const pages = findMany.mock.calls.map(([args]) => args);
    expect(pages[0].where).not.toHaveProperty("id");
    expect(pages[1].where).toMatchObject({ id: { gt: "claim_2" } });
    expect(pages[2].where).toMatchObject({ id: { gt: "claim_4" } });
    expect(pages[3].where).not.toHaveProperty("id");

    // The durable store is consulted once (fresh process); after that the
    // in-memory cursor drives every page despite read/write failures.
    expect(failingStore.read).toHaveBeenCalledTimes(1);
    expect(failingStore.write).toHaveBeenCalledTimes(4);
    const checkedBlocks = getBlock.mock.calls.map(([, ref]) => Number(ref.blockNumber));
    expect(checkedBlocks).toEqual([100, 101, 102, 103, 104, 100, 101]);
    expect(update).toHaveBeenCalledTimes(5);
  });
});
