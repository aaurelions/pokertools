import { describe, it, expect, vi } from "vitest";
import {
  createCanonicalDepositVerifier,
  createPrismaChainFreezeHandler,
  createPrismaIncidentSink,
  parseAssetRpcUrls,
  type DepositVerifierPrisma,
} from "../../src/services/canonical-deposit-verifier.js";
import {
  RpcQuorumError,
  TRANSFER_TOPIC,
  type CanonicalReceipt,
  type NormalizedLog,
  type NormalizedReceipt,
  type QuorumReader,
} from "../../src/services/chain-registry.js";

const CHAIN_ID = 31337;
const TOKEN = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";
const WALLET = "0x3333333333333333333333333333333333333333";
const OTHER_WALLET = "0x4444444444444444444444444444444444444444";
const ASSET_ID = `eip155:${CHAIN_ID}/erc20:${TOKEN}`;
const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

function pad32(address: string): string {
  return `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
}

function transferLog(
  logIndex: number,
  amount: bigint,
  to = TREASURY,
  from = WALLET
): NormalizedLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    logIndex,
    removed: false,
  };
}

function makeReceipt(
  logs: NormalizedLog[],
  overrides: Partial<NormalizedReceipt> = {}
): NormalizedReceipt {
  return {
    transactionHash: TX,
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    from: WALLET,
    to: TOKEN,
    contractAddress: null,
    status: "success",
    logs,
    ...overrides,
  };
}

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    treasuryAddress: TREASURY,
    confirmations: 5,
    status: "ACTIVE",
    ...overrides,
  };
}

function makePrisma(asset: Record<string, unknown> | null): DepositVerifierPrisma {
  return {
    asset: {
      findUnique: vi.fn(async () => asset as never),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    financialIncident: { create: vi.fn(async () => ({ id: "incident_1" })) },
  } as unknown as DepositVerifierPrisma;
}

function makeRegistry(canonical: CanonicalReceipt | null, authorized = true): QuorumReader {
  return {
    getCanonicalReceipt: vi.fn(async () => canonical),
    getTransactionReceipt: vi.fn(async () => canonical?.receipt ?? null),
    getBlock: vi.fn(async () => canonical!.block),
    getBlockNumber: vi.fn(async () => 120n),
    getSettlementBlockNumber: vi.fn(async () => 120n),
    getBalance: vi.fn(async () => 0n),
    getTokenBalance: vi.fn(async () => 0n),
    isChainAuthorized: vi.fn(() => authorized),
  };
}

function makeVerifier(
  asset: Record<string, unknown> | null,
  canonical: CanonicalReceipt | null,
  authorized = true
) {
  return createCanonicalDepositVerifier({
    prisma: makePrisma(asset),
    getRegistry: async () => makeRegistry(canonical, authorized),
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    assetId: ASSET_ID,
    chainId: CHAIN_ID,
    txHash: TX,
    logIndex: 0,
    principalId: "user_1",
    walletAddress: WALLET,
    ...overrides,
  };
}

function canonical(receipt: NormalizedReceipt, confirmations = 10): CanonicalReceipt {
  return {
    receipt,
    block: {
      number: receipt.blockNumber,
      hash: receipt.blockHash,
      parentHash: `0x${"01".repeat(32)}`,
    },
    confirmations,
  };
}

describe("createCanonicalDepositVerifier", () => {
  it("verifies a valid direct treasury deposit and derives the amount", async () => {
    const verifier = makeVerifier(makeAsset(), canonical(makeReceipt([transferLog(0, 1000n)]), 10));

    const result = await verifier(input());

    expect(result.verified).toBe(true);
    expect(result.amountAtomic).toBe("1000");
    expect(result.blockNumber).toBe("100");
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.confirmations).toBe(10);
    expect(result.provenance).toBe("DIRECT_TREASURY");
  });

  it("rejects a transfer sender that is not the authenticated wallet", async () => {
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, OTHER_WALLET)]))
    );

    expect(await verifier(input())).toEqual({ verified: false, reason: "WRONG_SENDER" });
  });

  it("rejects a transfer recipient that is not the treasury", async () => {
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(0, 1000n, OTHER_WALLET, WALLET)]))
    );

    expect(await verifier(input())).toEqual({ verified: false, reason: "WRONG_RECIPIENT" });
  });

  it("rejects a transfer log for a different token", async () => {
    const log = { ...transferLog(0, 1000n), address: OTHER_WALLET };
    const verifier = makeVerifier(makeAsset(), canonical(makeReceipt([log])));

    expect(await verifier(input())).toEqual({ verified: false, reason: "WRONG_TOKEN" });
  });

  it("rejects a missing log index and a non-Transfer log", async () => {
    const nonTransfer = {
      ...transferLog(1, 1000n),
      topics: [`0x${"00".repeat(32)}`, pad32(WALLET), pad32(TREASURY)],
    };
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(0, 1000n), nonTransfer]))
    );

    expect(await verifier(input({ logIndex: 7 }))).toEqual({
      verified: false,
      reason: "LOG_NOT_FOUND",
    });
    expect(await verifier(input({ logIndex: 1 }))).toEqual({
      verified: false,
      reason: "NOT_ERC20_TRANSFER",
    });
  });

  it("selects the exact log index among multiple transfers", async () => {
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(2, 2000n), transferLog(5, 5000n)]))
    );

    const result = await verifier(input({ logIndex: 5 }));
    expect(result.verified).toBe(true);
    expect(result.amountAtomic).toBe("5000");
  });

  it("rejects mint transfers", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, zero)]))
    );

    expect(await verifier(input())).toEqual({ verified: false, reason: "MINT_TRANSFER" });
  });

  it("rejects a claim below the required confirmation depth", async () => {
    const verifier = makeVerifier(makeAsset(), canonical(makeReceipt([transferLog(0, 1000n)]), 1));
    expect(await verifier(input())).toEqual({
      verified: false,
      reason: "INSUFFICIENT_CONFIRMATIONS",
    });
  });

  it("rejects a frozen asset and an unauthorized chain", async () => {
    const frozen = makeVerifier(makeAsset({ status: "FROZEN" }), null);
    expect(await frozen(input())).toEqual({ verified: false, reason: "ASSET_FROZEN" });

    const unauthorized = makeVerifier(makeAsset(), null, false);
    expect(await unauthorized(input())).toEqual({
      verified: false,
      reason: "CHAIN_NOT_AUTHORIZED",
    });
  });

  it("rejects a missing receipt", async () => {
    const verifier = makeVerifier(makeAsset(), null);
    expect(await verifier(input())).toEqual({ verified: false, reason: "RECEIPT_NOT_FOUND" });
  });

  it("rejects an unsuccessful transaction", async () => {
    const verifier = makeVerifier(
      makeAsset(),
      canonical(makeReceipt([transferLog(0, 1000n)], { status: "reverted" }))
    );
    expect(await verifier(input())).toEqual({ verified: false, reason: "TX_NOT_SUCCESS" });
  });

  it("throws (never returns verified=false) on RPC quorum infrastructure failure", async () => {
    const verifier = createCanonicalDepositVerifier({
      prisma: makePrisma(makeAsset()),
      getRegistry: async () => {
        throw new RpcQuorumError("no endpoints", CHAIN_ID, {
          chainId: CHAIN_ID,
          method: "eth_getTransactionReceipt",
          reason: "no_responses",
          endpoints: [],
        });
      },
    });

    await expect(verifier(input())).rejects.toBeInstanceOf(RpcQuorumError);
  });
});

describe("parseAssetRpcUrls", () => {
  it("accepts string, object and wrapped-endpoint shapes", () => {
    expect(parseAssetRpcUrls(["https://a", "https://b"])).toEqual(["https://a", "https://b"]);
    expect(parseAssetRpcUrls([{ id: "x", url: "https://a" }, { url: "https://b" }])).toEqual([
      "https://a",
      "https://b",
    ]);
    expect(parseAssetRpcUrls({ endpoints: ["https://a"] })).toEqual(["https://a"]);
    expect(parseAssetRpcUrls(null)).toEqual([]);
  });
});

describe("createPrismaIncidentSink", () => {
  it("persists RPC_DISAGREEMENT under its canonical kind, not remapped", async () => {
    const create = vi.fn(async () => ({ id: "incident_1" }));
    const sink = createPrismaIncidentSink({
      financialIncident: { create },
    } as never);

    await sink.record({
      kind: "RPC_DISAGREEMENT",
      severity: "CRITICAL",
      status: "OPEN",
      chainId: CHAIN_ID,
      evidence: {
        chainId: CHAIN_ID,
        method: "eth_getTransactionReceipt",
        reason: "response_disagreement",
        endpoints: [],
      },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        status: "OPEN",
        chainId: CHAIN_ID,
        evidence: expect.objectContaining({
          reportedKind: "RPC_DISAGREEMENT",
          disagreement: true,
        }),
      }),
    });
  });

  it("persists RPC_QUORUM_FAILURE unchanged", async () => {
    const create = vi.fn(async () => ({ id: "incident_1" }));
    const sink = createPrismaIncidentSink({
      financialIncident: { create },
    } as never);

    await sink.record({
      kind: "RPC_QUORUM_FAILURE",
      severity: "CRITICAL",
      status: "OPEN",
      chainId: CHAIN_ID,
      evidence: {
        chainId: CHAIN_ID,
        method: "eth_getBalance",
        reason: "no_responses",
        endpoints: [],
      },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "RPC_QUORUM_FAILURE" }),
    });
  });
});
