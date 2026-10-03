/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/utils/prisma-client.js";
import {
  CanonicalDepositService,
  DepositClaimRejected,
  type DepositClaimVerifier,
} from "../../src/services/canonical-deposits.js";
import {
  createCanonicalDepositVerifier,
  createPrismaIncidentSink,
  type DepositVerifierPrisma,
} from "../../src/services/canonical-deposit-verifier.js";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";
import {
  DepositAssetFrozenError,
  FinancialIntentService,
} from "../../src/services/financial-intents.js";
import { FinancialIncidentService } from "../../src/services/financial-incidents.js";
import {
  runCanonicalDepositMonitorOnce,
  type CanonicalDepositMonitorDeps,
  type MonitorRegistry,
} from "../../src/workers/canonical-deposit-monitor.js";
import {
  RpcQuorumError,
  TRANSFER_TOPIC,
  type CanonicalReceipt,
  type NormalizedBlock,
  type NormalizedLog,
  type NormalizedReceipt,
  type QuorumReader,
} from "../../src/services/chain-registry.js";

/**
 * Deposit security integration tests — canonical direct-treasury path.
 *
 * Migrated from the removed derived-address custodial architecture. The old
 * assertions targeted `BlockchainManager` per-user derived deposit addresses,
 * `DepositSession`/`PaymentTransaction` scanning and the `Account`/`LedgerEntry`
 * cents ledger. Those components are gone; every still-valid security property
 * is now asserted against the canonical
 * `CanonicalDepositService` + `createCanonicalDepositVerifier` path:
 *
 *  - wrong chain / token / sender / recipient / log identity are rejected with
 *    stable machine reasons (`ASSET_MISMATCH`, `WRONG_TOKEN`, `WRONG_SENDER`,
 *    `WRONG_RECIPIENT`, `LOG_NOT_FOUND`, `NOT_ERC20_TRANSFER`);
 *  - one transaction with multiple deposit logs is resolved by exact `logIndex`;
 *  - zero-address mint transfers are rejected (`MINT_TRANSFER`);
 *  - confirmation depth is enforced (`INSUFFICIENT_CONFIRMATIONS`);
 *  - a reverted tx is rejected (`TX_NOT_SUCCESS`);
 *  - no credit is issued without verification, and no verifier means no credit;
 *  - duplicate claims are idempotent and never double-credit;
 *  - a reorg preserves the credited user liability and posts no duplicate order
 *    (the old "blockHash canonicality" assertion, now canonical);
 *  - RPC quorum failure is infrastructure, never a negative verification.
 *
 * The removed `BigInt cents conversion`, `minDeposit` and `lastScannedBlock`
 * assertions were properties of the deleted scanner; the equivalent canonical
 * properties are exact atomic on-chain amounts and deep-finality monitoring,
 * covered in `canonical-deposit-verifier.test.ts` and
 * `canonical-deposit-monitor.test.ts`.
 */

const CHAIN_ID = 31337;
const TOKEN = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";
const WALLET = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x4444444444444444444444444444444444444444";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TX = `0x${"ab".repeat(32)}`;
const OTHER_TX = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"11".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"22".repeat(32)}`;

let prisma: PrismaClient;
const createdAssetIds: string[] = [];
let assetSeq = 0;

function nextTokenAddress(): string {
  assetSeq += 1;
  return `0x${assetSeq.toString(16).padStart(40, "0")}`;
}

async function createAsset(
  overrides: {
    tokenAddress?: string;
    status?: "ACTIVE" | "DEGRADED" | "FROZEN";
    confirmations?: number;
    deepFinality?: number;
    treasuryAddress?: string;
  } = {}
) {
  const tokenAddress = overrides.tokenAddress ?? nextTokenAddress();
  const id = `eip155:${CHAIN_ID}/erc20:${tokenAddress}`;
  const asset = await prisma.asset.create({
    data: {
      id,
      chainId: CHAIN_ID,
      tokenAddress,
      symbol: "USDC",
      decimals: 6,
      status: overrides.status ?? "ACTIVE",
      confirmations: overrides.confirmations ?? 5,
      deepFinality: overrides.deepFinality ?? 12,
      treasuryAddress: overrides.treasuryAddress ?? TREASURY,
      rpcUrls: ["http://127.0.0.1:8545"],
      minGasAtomic: "0",
    },
  });
  createdAssetIds.push(id);
  return asset;
}

async function cleanupAsset(assetId: string): Promise<void> {
  await prisma.depositClaimRecord.deleteMany({ where: { assetId } });
  await prisma.journalPosting.deleteMany({ where: { assetId } });
  await prisma.journalTransaction.deleteMany({ where: { assetId } });
  await prisma.atomicAccount.deleteMany({ where: { assetId } });
  await prisma.financialIncident.deleteMany({ where: { assetId } });
  await prisma.asset.deleteMany({ where: { id: assetId } });
}

// ---------------------------------------------------------------------------
// Canonical verifier fixtures (mirrors canonical-deposit-verifier.test.ts).
// ---------------------------------------------------------------------------

function pad32(address: string): string {
  return `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
}

function transferLog(
  logIndex: number,
  amount: bigint,
  to = TREASURY,
  from = WALLET,
  token = TOKEN
): NormalizedLog {
  return {
    address: token,
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

function makeRegistry(canonicalReceipt: CanonicalReceipt | null, authorized = true): QuorumReader {
  return {
    getCanonicalReceipt: vi.fn(async () => canonicalReceipt),
    getTransactionReceipt: vi.fn(async () => canonicalReceipt?.receipt ?? null),
    getBlock: vi.fn(async () => canonicalReceipt!.block),
    getBlockNumber: vi.fn(async () => 120n),
    getSettlementBlockNumber: vi.fn(async () => 120n),
    getBalance: vi.fn(async () => 0n),
    getTokenBalance: vi.fn(async () => 0n),
    isChainAuthorized: vi.fn(() => authorized),
  };
}

function verifierFor(
  canonicalReceipt: CanonicalReceipt | null,
  authorized = true
): DepositClaimVerifier {
  return createCanonicalDepositVerifier({
    prisma: prisma as unknown as DepositVerifierPrisma,
    getRegistry: async () => makeRegistry(canonicalReceipt, authorized),
  });
}

function verificationInput(assetId: string, overrides: Record<string, unknown> = {}) {
  return {
    assetId,
    chainId: CHAIN_ID,
    txHash: TX,
    logIndex: 0,
    principalId: "principal_1",
    walletAddress: WALLET,
    ...overrides,
  };
}

function verifyOk(amountAtomic = "1000"): DepositClaimVerifier {
  return vi.fn(async () => ({
    verified: true,
    amountAtomic,
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    confirmations: 5,
    provenance: "DIRECT_TREASURY" as const,
  }));
}

function verifyNo(reason = "WRONG_SENDER"): DepositClaimVerifier {
  return vi.fn(async () => ({ verified: false, reason }));
}

async function claim(
  service: CanonicalDepositService,
  assetId: string,
  overrides: Record<string, unknown> = {}
) {
  return service.claimDirectTreasury({
    principalId: "principal_1",
    walletAddress: WALLET,
    assetId,
    txHash: TX,
    logIndex: 0,
    ...overrides,
  });
}

beforeAll(() => {
  prisma = createPrismaClient();
});

afterEach(async () => {
  for (const assetId of createdAssetIds.splice(0)) {
    await cleanupAsset(assetId);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("deposit security: canonical on-chain verification", () => {
  it("verifies an exact direct-treasury transfer and derives the on-chain amount", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)]), 10)
    );

    const result = await verifier(verificationInput(asset.id));

    expect(result.verified).toBe(true);
    expect(result.amountAtomic).toBe("1000");
    expect(result.blockNumber).toBe("100");
    expect(result.blockHash).toBe(BLOCK_HASH);
    expect(result.confirmations).toBe(10);
    expect(result.provenance).toBe("DIRECT_TREASURY");
  });

  it("rejects a claim for a different chain", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)]))
    );

    const result = await verifier(verificationInput(asset.id, { chainId: CHAIN_ID + 1 }));
    expect(result).toEqual({ verified: false, reason: "ASSET_MISMATCH" });
  });

  it("rejects a log emitted by a different token", async () => {
    const asset = await createAsset();
    const log = {
      ...transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress),
      address: STRANGER,
    };
    const verifier = verifierFor(canonical(makeReceipt([log])));

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "WRONG_TOKEN" });
  });

  it("rejects a transfer whose sender is not the authenticated wallet", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, STRANGER, asset.tokenAddress)]))
    );

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "WRONG_SENDER" });
  });

  it("rejects a transfer whose recipient is not the treasury", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, STRANGER, WALLET, asset.tokenAddress)]))
    );

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "WRONG_RECIPIENT" });
  });

  it("rejects a missing log index and a non-Transfer log", async () => {
    const asset = await createAsset();
    const nonTransfer: NormalizedLog = {
      ...transferLog(1, 1000n, TREASURY, WALLET, asset.tokenAddress),
      topics: [`0x${"00".repeat(32)}`, pad32(WALLET), pad32(TREASURY)],
    };
    const verifier = verifierFor(
      canonical(
        makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress), nonTransfer])
      )
    );

    expect(await verifier(verificationInput(asset.id, { logIndex: 7 }))).toEqual({
      verified: false,
      reason: "LOG_NOT_FOUND",
    });
    expect(await verifier(verificationInput(asset.id, { logIndex: 1 }))).toEqual({
      verified: false,
      reason: "NOT_ERC20_TRANSFER",
    });
  });

  it("resolves each exact log when one transaction emits multiple deposit logs", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(
        makeReceipt([
          transferLog(2, 2000n, TREASURY, WALLET, asset.tokenAddress),
          transferLog(5, 5000n, TREASURY, WALLET, asset.tokenAddress),
        ])
      )
    );

    const first = await verifier(verificationInput(asset.id, { logIndex: 2 }));
    const second = await verifier(verificationInput(asset.id, { logIndex: 5 }));

    expect(first.verified).toBe(true);
    expect(first.amountAtomic).toBe("2000");
    expect(second.verified).toBe(true);
    expect(second.amountAtomic).toBe("5000");
  });

  it("rejects zero-address mint transfers", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, ZERO_ADDRESS, asset.tokenAddress)]))
    );

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "MINT_TRANSFER" });
  });

  it("enforces the configured confirmation depth", async () => {
    const asset = await createAsset({ confirmations: 5 });
    const verifier = verifierFor(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)]), 1)
    );

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it("rejects a reverted transaction", async () => {
    const asset = await createAsset();
    const verifier = verifierFor(
      canonical(
        makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)], {
          status: "reverted",
        })
      )
    );

    const result = await verifier(verificationInput(asset.id));
    expect(result).toEqual({ verified: false, reason: "TX_NOT_SUCCESS" });
  });

  it("rejects a frozen asset and an unauthorized chain", async () => {
    const frozenAsset = await createAsset({ status: "FROZEN" });
    expect(await verifierFor(null)(verificationInput(frozenAsset.id))).toEqual({
      verified: false,
      reason: "ASSET_FROZEN",
    });

    const asset = await createAsset();
    expect(
      await verifierFor(
        canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)])),
        false
      )(verificationInput(asset.id))
    ).toEqual({ verified: false, reason: "CHAIN_NOT_AUTHORIZED" });
  });

  it("treats an RPC quorum failure as infrastructure, not a negative verification", async () => {
    // Replaces the removed rpcUrl/rpcUrlBackup failover assertion: the canonical
    // path fails closed and throws so the route maps it to 503, rather than
    // silently treating a lost RPC as a reverted/non-canonical deposit.
    const asset = await createAsset();
    const verifier = createCanonicalDepositVerifier({
      prisma: prisma as unknown as DepositVerifierPrisma,
      getRegistry: async () => {
        throw new RpcQuorumError("no endpoints", CHAIN_ID, {
          chainId: CHAIN_ID,
          method: "eth_getTransactionReceipt",
          reason: "no_responses",
          endpoints: [],
        });
      },
    });

    await expect(verifier(verificationInput(asset.id))).rejects.toBeInstanceOf(RpcQuorumError);
  });
});

describe("deposit security: canonical credit path", () => {
  it("issues no credit when the verifier does not verify", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma, { verifier: verifyNo() });

    await expect(claim(service, asset.id)).rejects.toMatchObject({
      code: "DEPOSIT_NOT_VERIFIED",
    });

    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await prisma.atomicAccount.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("issues no credit when no verifier is configured", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma);

    await expect(claim(service, asset.id)).rejects.toMatchObject({
      code: "VERIFICATION_UNAVAILABLE",
    });
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("rejects a non-canonical claim identity before verification", async () => {
    const asset = await createAsset();
    const verifier = verifyOk();
    const service = new CanonicalDepositService(prisma, { verifier });

    await expect(
      claim(service, asset.id, { txHash: "not-a-hash", logIndex: -1 })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("credits a verified claim exactly once and is idempotent on replay", async () => {
    const asset = await createAsset();
    const verifier = verifyOk("1000");
    const service = new CanonicalDepositService(prisma, { verifier });

    const first = await claim(service, asset.id);
    expect(first.status).toBe("CREDITED");
    expect(first.amountAtomic).toBe("1000");
    expect(first.idempotent).toBe(false);

    const balance = await prisma.atomicAccount.findUnique({
      where: {
        assetId_ownerKey_class: {
          assetId: asset.id,
          ownerKey: "principal_1",
          class: "USER_AVAILABLE",
        },
      },
    });
    expect(balance?.balanceAtomic).toBe("1000");

    // Replay: same exact log identity returns the same claim with no re-verify
    // and no second journal.
    const second = await claim(service, asset.id);
    expect(second.idempotent).toBe(true);
    expect(second.id).toBe(first.id);
    expect(verifier).toHaveBeenCalledTimes(1);

    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(1);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(1);

    const afterReplay = await prisma.atomicAccount.findUnique({
      where: {
        assetId_ownerKey_class: {
          assetId: asset.id,
          ownerKey: "principal_1",
          class: "USER_AVAILABLE",
        },
      },
    });
    expect(afterReplay?.balanceAtomic).toBe("1000");
  });

  it("rejects a duplicate claim identity that is not yet credited", async () => {
    const asset = await createAsset();
    // Simulate an in-flight OBSERVED claim row with the same log identity.
    await prisma.depositClaimRecord.create({
      data: {
        assetId: asset.id,
        principalId: "principal_1",
        chainId: CHAIN_ID,
        txHash: TX,
        logIndex: 0,
        amountAtomic: "1000",
        status: "OBSERVED",
      },
    });
    const verifier = verifyOk();
    const service = new CanonicalDepositService(prisma, { verifier });

    await expect(claim(service, asset.id)).rejects.toMatchObject({ code: "DUPLICATE_CLAIM" });
    expect(verifier).not.toHaveBeenCalled();
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("rejects an invalid amount returned by the verifier without crediting", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma, { verifier: verifyOk("0xbad") });

    await expect(claim(service, asset.id)).rejects.toMatchObject({
      code: "VERIFICATION_INVALID",
    });
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("rejects a new credit when the asset freezes after verification but before the ledger lock", async () => {
    const asset = await createAsset();
    // The freeze lands after the verifier's own ACTIVE read and before
    // `creditDepositClaim` takes the durable asset lock. The fresh read under
    // the lock must observe FROZEN and admit no new risk.
    const verifier = vi.fn(async () => {
      await prisma.asset.update({ where: { id: asset.id }, data: { status: "FROZEN" } });
      return {
        verified: true,
        amountAtomic: "1000",
        blockNumber: "100",
        blockHash: BLOCK_HASH,
        confirmations: 5,
        provenance: "DIRECT_TREASURY" as const,
      };
    }) as unknown as DepositClaimVerifier;
    const service = new CanonicalDepositService(prisma, { verifier });

    await expect(claim(service, asset.id)).rejects.toMatchObject({ code: "ASSET_FROZEN" });
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await prisma.atomicAccount.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("blocks a direct new credit while the asset is frozen under the ledger lock", async () => {
    const asset = await createAsset();
    await prisma.asset.update({ where: { id: asset.id }, data: { status: "FROZEN" } });
    const ledger = new AtomicLedger(prisma);
    const intents = new FinancialIntentService(prisma, ledger);

    await expect(
      intents.creditDepositClaim({
        principalId: "principal_1",
        assetId: asset.id,
        chainId: CHAIN_ID,
        txHash: TX,
        logIndex: 0,
        amountAtomic: "1000",
      })
    ).rejects.toBeInstanceOf(DepositAssetFrozenError);
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(0);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(0);
  });

  it("returns the exact durable credited claim on replay while the asset is frozen", async () => {
    const asset = await createAsset();
    const verifier = verifyOk("1000");
    const service = new CanonicalDepositService(prisma, { verifier });
    const first = await claim(service, asset.id);
    expect(first.idempotent).toBe(false);

    await prisma.asset.update({ where: { id: asset.id }, data: { status: "FROZEN" } });

    // A freeze blocks new risk, not the idempotent acknowledgement of a credit
    // that already committed.
    const replay = await claim(service, asset.id);
    expect(replay.idempotent).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(1);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(1);
  });

  it("never adopts another principal's credited claim on replay", async () => {
    const asset = await createAsset();
    const verifier = verifyOk("1000");
    const service = new CanonicalDepositService(prisma, { verifier });
    await claim(service, asset.id);

    await expect(claim(service, asset.id, { principalId: "principal_2" })).rejects.toMatchObject({
      code: "DUPLICATE_CLAIM",
    });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(await prisma.depositClaimRecord.count({ where: { assetId: asset.id } })).toBe(1);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(1);
  });

  it("refuses to adopt a credited claim when the replay amount differs", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma, { verifier: verifyOk("1000") });
    await claim(service, asset.id);
    const ledger = new AtomicLedger(prisma);
    const intents = new FinancialIntentService(prisma, ledger);

    await expect(
      intents.creditDepositClaim({
        principalId: "principal_1",
        assetId: asset.id,
        chainId: CHAIN_ID,
        txHash: TX,
        logIndex: 0,
        amountAtomic: "999",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(1);
  });

  it("exposes DepositClaimRejected as an AppError subclass with a stable code", () => {
    const error = new DepositClaimRejected("SOME_CODE", "message");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("SOME_CODE");
  });
});

describe("deposit security: canonical reorg preservation", () => {
  it("preserves user liability and posts no duplicate obligation on a reorg", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma, { verifier: verifyOk("1000") });
    const credited = await claim(service, asset.id);
    expect(credited.status).toBe("CREDITED");

    const accountKey = {
      assetId_ownerKey_class: {
        assetId: asset.id,
        ownerKey: "principal_1",
        class: "USER_AVAILABLE" as const,
      },
    };
    const balanceBefore = await prisma.atomicAccount.findUnique({ where: accountKey });
    const journalsBefore = await prisma.journalTransaction.count({ where: { assetId: asset.id } });

    const ledger = new AtomicLedger(prisma);
    const intents = new FinancialIntentService(prisma, ledger);
    const incidents = new FinancialIncidentService(prisma, ledger);

    const reorgedBlock: NormalizedBlock = {
      number: 100n,
      hash: OTHER_BLOCK_HASH,
      parentHash: `0x${"01".repeat(32)}`,
    };
    const base = makeRegistry(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)]))
    );
    const registry: MonitorRegistry = {
      ...base,
      getSettlementBlockNumber: vi.fn(async () => 200n),
      getBlock: vi.fn(async () => reorgedBlock),
      freezeChain: vi.fn(async () => undefined),
    };

    const result = await runCanonicalDepositMonitorOnce({
      prisma,
      registry,
      intents,
      incidents,
    } as unknown as CanonicalDepositMonitorDeps);

    expect(result.reorged).toBeGreaterThanOrEqual(1);

    const claimAfter = await prisma.depositClaimRecord.findUnique({ where: { id: credited.id } });
    expect(claimAfter?.status).toBe("ORPHANED");

    const incident = await prisma.financialIncident.findFirst({
      where: { kind: "DEPOSIT_REORG", affectedId: credited.id },
    });
    expect(incident).not.toBeNull();
    expect(incident?.evidence).toMatchObject({
      amountAtomic: "1000",
      principalId: "principal_1",
      creditedJournalId: credited.creditedJournalId,
    });
    expect(String((incident?.evidence as { note?: string }).note)).toContain(
      "User liability preserved"
    );

    const assetAfter = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(assetAfter?.status).toBe("FROZEN");

    // Liability preserved: same balance, no duplicate journal obligation.
    const balanceAfter = await prisma.atomicAccount.findUnique({ where: accountKey });
    expect(balanceAfter?.balanceAtomic).toBe(balanceBefore?.balanceAtomic);
    expect(await prisma.journalTransaction.count({ where: { assetId: asset.id } })).toBe(
      journalsBefore
    );

    // Re-running the monitor must not create a second reorg incident.
    const second = await runCanonicalDepositMonitorOnce({
      prisma,
      registry,
      intents,
      incidents,
    } as unknown as CanonicalDepositMonitorDeps);
    expect(second.reorged).toBe(0);
    expect(
      await prisma.financialIncident.count({
        where: { kind: "DEPOSIT_REORG", affectedId: credited.id },
      })
    ).toBe(1);
  });

  it("preserves the credited claim on quorum failure instead of concluding a reorg", async () => {
    const asset = await createAsset();
    const service = new CanonicalDepositService(prisma, { verifier: verifyOk("1000") });
    const credited = await claim(service, asset.id);

    const ledger = new AtomicLedger(prisma);
    const intents = new FinancialIntentService(prisma, ledger);
    const incidents = new FinancialIncidentService(prisma, ledger);

    const base = makeRegistry(
      canonical(makeReceipt([transferLog(0, 1000n, TREASURY, WALLET, asset.tokenAddress)]))
    );
    const registry: MonitorRegistry = {
      ...base,
      getSettlementBlockNumber: vi.fn(async () => {
        throw new RpcQuorumError("no quorum", CHAIN_ID, {
          chainId: CHAIN_ID,
          method: "eth_blockNumber",
          reason: "no_responses",
          endpoints: [],
        });
      }),
      freezeChain: vi.fn(async () => undefined),
    };

    const result = await runCanonicalDepositMonitorOnce({
      prisma,
      registry,
      intents,
      incidents,
    } as unknown as CanonicalDepositMonitorDeps);

    expect(result.preserved).toBeGreaterThanOrEqual(1);
    const claimAfter = await prisma.depositClaimRecord.findUnique({ where: { id: credited.id } });
    expect(claimAfter?.status).toBe("CREDITED");
    expect(
      await prisma.financialIncident.count({
        where: { kind: "DEPOSIT_REORG", affectedId: credited.id },
      })
    ).toBe(0);
    const assetAfter = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(assetAfter?.status).toBe("ACTIVE");
  });
});

describe("createPrismaIncidentSink durable dedup", () => {
  it("keeps one PK row per kind+chain under parallel record and reopens on recurrence", async () => {
    const chainId = 900_000 + Math.floor(Math.random() * 100_000);
    const sink = createPrismaIncidentSink(prisma);
    const base = {
      kind: "RPC_QUORUM_FAILURE" as const,
      severity: "CRITICAL" as const,
      status: "OPEN" as const,
      chainId,
      evidence: { chainId, method: "eth_blockNumber", reason: "no_responses", endpoints: [] },
    };

    // Parallel records must converge on the stable primary key: the existing
    // PK constraint (no new schema) makes duplicate rows impossible.
    await Promise.all([sink.record(base), sink.record(base), sink.record(base)]);

    const rows = await prisma.financialIncident.findMany({ where: { chainId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`rpc-incident:RPC_QUORUM_FAILURE:${chainId}`);
    const originalVersion = rows[0].version;

    // Operator resolution, then the same condition recurs.
    await prisma.financialIncident.update({
      where: { id: rows[0].id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await sink.record({
      ...base,
      evidence: { ...base.evidence, reason: "no_responses_again" },
    });

    const reopened = await prisma.financialIncident.findUniqueOrThrow({
      where: { id: rows[0].id },
    });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.version).toBe(originalVersion + 1);
    expect(reopened.evidence).toMatchObject({ reason: "no_responses_again" });
    expect(await prisma.financialIncident.count({ where: { chainId } })).toBe(1);

    await prisma.financialIncident.deleteMany({ where: { chainId } });
  });
});
