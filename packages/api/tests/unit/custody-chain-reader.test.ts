import { describe, expect, it } from "vitest";
import {
  createCustodyQuorumReader,
  createAssetBackedCustodyQuorumReader,
  type CustodyChainRegistryLike,
} from "../../src/services/custody-chain-reader.js";
import {
  TRANSFER_TOPIC,
  type NormalizedBlock,
  type NormalizedReceipt,
} from "../../src/services/chain-registry.js";

const ASSET = {
  assetId: "eip155:31337/erc20:0x1111111111111111111111111111111111111111",
  chainId: 31337,
  tokenAddress: "0x1111111111111111111111111111111111111111",
  treasuryAddress: "0x3333333333333333333333333333333333333333",
};
const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const WALLET = "0x2222222222222222222222222222222222222222";

function pad32(address: string): string {
  return `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
}

function receipt(): NormalizedReceipt {
  return {
    transactionHash: TX,
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    from: WALLET,
    to: ASSET.tokenAddress,
    contractAddress: null,
    status: "success",
    logs: [
      {
        address: ASSET.tokenAddress,
        topics: [TRANSFER_TOPIC, pad32(WALLET), pad32(ASSET.treasuryAddress)],
        data: `0x${1000n.toString(16).padStart(64, "0")}`,
        logIndex: 0,
        removed: false,
      },
    ],
  };
}

function block(): NormalizedBlock {
  return { number: 100n, hash: BLOCK_HASH, parentHash: `0x${"01".repeat(32)}` };
}

function makeReader(overrides: Partial<CustodyChainRegistryLike> = {}) {
  const registry: CustodyChainRegistryLike = {
    getTransactionReceipt: async () => receipt(),
    getBlock: async () => block(),
    getSettlementBlockNumber: async () => 110n,
    getBalance: async () => 1_000n,
    getTokenBalance: async () => 500n,
    getTransactionCount: async () => 7n,
    isChainAuthorized: () => true,
    getEndpoints: () => [
      { id: "a", url: "http://rpc-a.example" },
      { id: "b", url: "http://rpc-b.example" },
    ],
    ...overrides,
  };
  return createCustodyQuorumReader(registry, { minFanout: 2 });
}

describe("createCustodyQuorumReader", () => {
  it("cannot manufacture a custody observation floor stronger than the actual RPC threshold", () => {
    expect(() =>
      createAssetBackedCustodyQuorumReader({} as never, { quorum: 2, minFanout: 3 })
    ).toThrow("minimum observations exceed");
    expect(() =>
      createAssetBackedCustodyQuorumReader({} as never, { quorum: 1, minFanout: 2 })
    ).toThrow("minimum observations exceed");
  });
  it("maps a receipt with decoded ERC-20 transfers and independent observations", async () => {
    const reader = makeReader();
    const result = await reader.transactionReceipt(ASSET, TX);

    expect(result.agreed).toBe(true);
    expect(result.value?.status).toBe("success");
    expect(result.value?.transfers).toEqual([
      {
        tokenAddress: ASSET.tokenAddress,
        from: WALLET,
        to: ASSET.treasuryAddress,
        amountAtomic: "1000",
        logIndex: 0,
        txHash: TX,
      },
    ]);
    // Two independent observations, never a single endpoint.
    expect(result.observations).toHaveLength(2);
    // Endpoint URLs (which may carry credentials) never leak into observations.
    expect(JSON.stringify(result.observations)).not.toContain("rpc-a.example");
  });

  it("reports a unanimous absent receipt as an agreed null observation", async () => {
    const reader = makeReader({ getTransactionReceipt: async () => null });
    const result = await reader.transactionReceipt(ASSET, TX);
    expect(result.agreed).toBe(true);
    expect(result.value).toBeNull();
    expect(result.observations.length).toBeGreaterThanOrEqual(2);
  });

  it("reports registry failures as not agreed (never a reorg conclusion)", async () => {
    const reader = makeReader({
      getTransactionReceipt: async () => {
        throw new Error("transport http://user:secret@rpc.example/key");
      },
    });
    const result = await reader.transactionReceipt(ASSET, TX);
    expect(result.agreed).toBe(false);
    expect(result.value).toBeNull();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // Stable error name only; raw credential-bearing messages never surface.
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps the canonical block and settlement height", async () => {
    const reader = makeReader();
    const blockResult = await reader.block(ASSET, 100);
    expect(blockResult.agreed).toBe(true);
    expect(blockResult.value).toEqual({
      number: 100,
      hash: BLOCK_HASH,
      parentHash: `0x${"01".repeat(32)}`,
    });

    const height = await reader.blockNumber(ASSET);
    expect(height.agreed).toBe(true);
    expect(height.value).toBe(110);
  });

  it("maps treasury nonce and native/token balances through quorum", async () => {
    const reader = makeReader();
    expect((await reader.transactionCount(ASSET, ASSET.treasuryAddress, "pending")).value).toBe(7);
    expect((await reader.nativeBalance(ASSET, ASSET.treasuryAddress)).value).toBe(1_000n);
    expect((await reader.erc20BalanceOf(ASSET, ASSET.treasuryAddress)).value).toBe(500n);
  });

  it("fails closed when the settlement height quorum is unavailable", async () => {
    const reader = makeReader({
      getSettlementBlockNumber: async () => {
        throw new Error("insufficient quorum");
      },
    });
    const height = await reader.blockNumber(ASSET);
    expect(height.agreed).toBe(false);
    expect(height.value).toBeNull();
  });
});
