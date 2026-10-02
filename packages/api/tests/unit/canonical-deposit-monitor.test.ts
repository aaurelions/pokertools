import { describe, it, expect, vi } from "vitest";
import {
  runCanonicalDepositMonitorOnce,
  type CanonicalDepositMonitorDeps,
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

describe("runCanonicalDepositMonitorOnce", () => {
  it("advances confirmations and counts deep-final claims", async () => {
    const { deps, update, recordDepositReorg } = makeDeps({
      claim: baseClaim(),
      deepFinality: 50,
      head: 160n,
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({ checked: 1, deepFinalized: 1, reorged: 0, preserved: 0 });
    expect(update).toHaveBeenCalledWith({ where: { id: "claim_1" }, data: { confirmations: 61 } });
    expect(recordDepositReorg).not.toHaveBeenCalled();
  });

  it("records a reorg, freezes the chain and freezes the asset without touching the credit", async () => {
    const { deps, recordDepositReorg, freezeAsset, freezeChain, update } = makeDeps({
      claim: baseClaim(),
      block: { number: 100n, hash: OTHER_BLOCK_HASH, parentHash: `0x${"01".repeat(32)}` },
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({ checked: 1, deepFinalized: 0, reorged: 1, preserved: 0 });
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

    expect(result).toEqual({ checked: 1, deepFinalized: 0, reorged: 0, preserved: 1 });
    expect(recordDepositReorg).not.toHaveBeenCalled();
    expect(freezeChain).not.toHaveBeenCalled();
  });

  it("preserves claims that have no stored block number", async () => {
    const { deps, recordDepositReorg } = makeDeps({
      claim: baseClaim({ blockNumber: null }),
    });

    const result = await runCanonicalDepositMonitorOnce(deps);

    expect(result).toEqual({ checked: 1, deepFinalized: 0, reorged: 0, preserved: 1 });
    expect(recordDepositReorg).not.toHaveBeenCalled();
  });
});
