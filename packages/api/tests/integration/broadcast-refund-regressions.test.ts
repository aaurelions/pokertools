/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, expect, it } from "vitest";
import crypto from "node:crypto";
import { initTestContext, runCleanup, type TestContext } from "../helpers/test-utils.js";
import {
  PrismaWithdrawalStore,
  PrismaIncidentStore,
  PrismaAssetRegistry,
} from "../../../custody/src/core/prisma-store.js";
import {
  WithdrawalWorkflow,
  hasExactPersistedBytes,
} from "../../../custody/src/core/withdrawal-workflow.js";

/**
 * Conservative broadcast-failure semantics (replaces the removed automatic
 * refund helper).
 *
 * The old `refundBroadcastWithdrawal` credited a reserve back on a broadcast
 * failure. New authority: an ambiguous broadcast retains the economic obligation
 * and the exact signed bytes; recovery re-broadcasts the SAME bytes and never
 * signs a replacement or refunds. A reverted receipt fails the record without
 * crediting anyone.
 */

const CHAIN_ID = 31337;
const TOKEN = "0x00000000000000000000000000000000000000aa";
const TREASURY = "0x00000000000000000000000000000000000000bb";
const DESTINATION = "0x00000000000000000000000000000000000000cc";
const ASSET_ID = `eip155:${CHAIN_ID}/erc20:${TOKEN}`;
const CALL_DATA = "0xa9059cbb" as `0x${string}`;

let ctx: TestContext;
let assetId: string;

type QuorumObservation<T> = { rpcUrl: string; value: T };
function quorumAgreed<T>(value: T): {
  agreed: boolean;
  value: T | null;
  observations: Array<QuorumObservation<T>>;
  errors: Array<{ rpcUrl: string; message: string }>;
} {
  return {
    agreed: true,
    value,
    observations: [
      { rpcUrl: "http://rpc-a", value },
      { rpcUrl: "http://rpc-b", value },
    ],
    errors: [],
  };
}

class FakeQuorum {
  receipt: unknown = null;
  receiptAgreed = true;
  async nativeBalance() {
    return quorumAgreed(10_000n);
  }
  async erc20BalanceOf() {
    return quorumAgreed(10_000n);
  }
  async transactionCount() {
    return quorumAgreed(0);
  }
  async transactionReceipt() {
    return this.receiptAgreed ? quorumAgreed(this.receipt) : quorumAgreed(null);
  }
  async block(_asset: unknown, blockNumber: number) {
    // The canonical block hash must match the observed receipt's block hash so
    // the workflow proceeds past the canonicality gate. Absent a receipt hash,
    // return a deterministic zero hash (block is only read after a receipt).
    const receipt = this.receipt as { blockHash?: string } | null;
    const hash = receipt?.blockHash ?? `0x${"00".repeat(32)}`;
    return quorumAgreed({ number: blockNumber, hash, parentHash: `0x${"00".repeat(32)}` });
  }
  async blockNumber() {
    return quorumAgreed(1_000);
  }
}

class FakeBroadcaster {
  broadcasts: string[] = [];
  failCount = 0;
  hash = `0x${"cd".repeat(32)}` as `0x${string}`;
  async broadcast(_asset: unknown, rawTransaction: `0x${string}`): Promise<`0x${string}`> {
    this.broadcasts.push(rawTransaction);
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error("transport error at http://user:secret@rpc.example/key");
    }
    return this.hash;
  }
}

class FakeAccounting {
  completed: string[] = [];
  obligations: string[] = [];
  async completeWithdrawal(record: { intentId: string }) {
    this.completed.push(record.intentId);
    return { journalId: `complete:${record.intentId}` };
  }
  async recordObligation(record: { intentId: string }) {
    this.obligations.push(record.intentId);
    return { journalId: `obligation:${record.intentId}` };
  }
  async reverseObligation() {
    return { journalId: null };
  }
  async recordReconciliation(_evidence: unknown) {
    return { journalId: "reconcile" };
  }
  async expectedTreasuryAtomic() {
    return "0";
  }
}

class FakeSigner {
  calls = 0;
  async signTransfer(): Promise<never> {
    this.calls += 1;
    throw new Error("signer must never be called for an already-persisted record");
  }
}

function buildWorkflow(options: {
  quorum: FakeQuorum;
  broadcaster: FakeBroadcaster;
  accounting: FakeAccounting;
  signer: FakeSigner;
}) {
  const store = new PrismaWithdrawalStore(ctx.app.prisma as never, process.env.DATABASE_URL ?? "");
  const incidents = new PrismaIncidentStore(ctx.app.prisma as never);
  const assets = new PrismaAssetRegistry(ctx.app.prisma as never);
  const workflow = new WithdrawalWorkflow({
    store: store as never,
    incidents: incidents as never,
    assets: assets as never,
    accounting: options.accounting as never,
    signer: options.signer as never,
    quorum: options.quorum as never,
    broadcaster: options.broadcaster as never,
    clock: { now: () => Date.now() } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    config: { minQuorum: 2, maxScanBatch: 25 },
  });
  return { workflow, store };
}

async function createPersistedRecord(
  intentId: string
): Promise<{ rawTx: `0x${string}`; txHash: `0x${string}` }> {
  const rawTx = `0x${crypto.randomBytes(64).toString("hex")}` as `0x${string}`;
  const txHash = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
  const store = new PrismaWithdrawalStore(ctx.app.prisma as never, process.env.DATABASE_URL ?? "");
  await store.create({
    intentId,
    principalId: ctx.users[0].id,
    assetId,
    chainId: CHAIN_ID,
    destination: DESTINATION as never,
    amountAtomic: "100",
    nonce: Date.now() + Math.floor(Math.random() * 100_000),
    deadline: Math.floor(Date.now() / 1000) + 600,
    signature: `0x${"11".repeat(65)}` as never,
    treasuryAddress: TREASURY as never,
    tokenAddress: TOKEN as never,
  } as never);
  await store.transition({
    intentId,
    from: ["RESERVED"],
    to: "PERSISTED",
    patch: {
      signedRawTx: rawTx,
      signedCallData: CALL_DATA,
      signedValueAtomic: "0",
      txHash,
      treasuryNonce: 0,
    },
  } as never);
  return { rawTx, txHash };
}

beforeAll(async () => {
  ctx = await initTestContext(1, 1000);
  // The asset id is deterministic; clear any residue from a previous failed run.
  await ctx.app.prisma.financialIncident.deleteMany({ where: { assetId: ASSET_ID } });
  await ctx.app.prisma.withdrawalIntentRecord.deleteMany({ where: { assetId: ASSET_ID } });
  await ctx.app.prisma.asset.deleteMany({ where: { id: ASSET_ID } }).catch(() => undefined);
  const asset = await ctx.app.prisma.asset.create({
    data: {
      id: ASSET_ID,
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      symbol: "USDC",
      decimals: 6,
      status: "ACTIVE",
      confirmations: 3,
      deepFinality: 6,
      treasuryAddress: TREASURY,
      rpcUrls: ["http://rpc-a", "http://rpc-b"],
      minGasAtomic: "1000",
    },
  });
  assetId = asset.id;
});

afterAll(async () => {
  if (!ctx) return;
  await ctx.app.prisma.financialIncident.deleteMany({ where: { assetId } });
  await ctx.app.prisma.withdrawalIntentRecord.deleteMany({ where: { assetId } });
  await ctx.app.prisma.asset.deleteMany({ where: { id: assetId } }).catch(() => undefined);
  await runCleanup(ctx.cleanup);
});

it("retains the exact signed bytes and obligation on an ambiguous broadcast, then rebroadcasts them", async () => {
  const intentId = `ambiguous-${Date.now()}`;
  const { rawTx, txHash } = await createPersistedRecord(intentId);

  const quorum = new FakeQuorum();
  const broadcaster = new FakeBroadcaster();
  broadcaster.hash = txHash;
  broadcaster.failCount = 1;
  const accounting = new FakeAccounting();
  const signer = new FakeSigner();
  const { workflow, store } = buildWorkflow({ quorum, broadcaster, accounting, signer });

  // First tick: broadcast transport failure is ambiguous, never a refund.
  const first = await workflow.processIntent(intentId);
  expect(first.action).toBe("ambiguous");
  expect(first.state).toBe("AMBIGUOUS");

  const afterFailure = (await store.get(intentId))!;
  expect(afterFailure.state).toBe("AMBIGUOUS");
  // Exact bytes are retained; nothing was re-signed or refunded.
  expect(afterFailure.signedRawTx).toBe(rawTx);
  expect(afterFailure.txHash).toBe(txHash);
  expect(hasExactPersistedBytes(afterFailure)).toBe(true);
  expect(signer.calls).toBe(0);
  expect(accounting.completed).toHaveLength(0);
  expect(accounting.obligations).toHaveLength(0);

  const incidents = await ctx.app.prisma.financialIncident.findMany({ where: { assetId } });
  expect(incidents.some((incident) => incident.kind === "AMBIGUOUS_CUSTODY_STATE")).toBe(true);

  // Second tick: the SAME bytes are re-broadcast, never new signed bytes.
  const second = await workflow.processIntent(intentId);
  expect(second.action).toBe("rebroadcast");
  expect(second.state).toBe("BROADCAST");
  expect(broadcaster.broadcasts).toEqual([rawTx, rawTx]);
  expect(signer.calls).toBe(0);

  const afterRebroadcast = (await store.get(intentId))!;
  expect(afterRebroadcast.state).toBe("BROADCAST");
  expect(afterRebroadcast.signedRawTx).toBe(rawTx);
  expect(accounting.completed).toHaveLength(0);
});

it("blocks a reverted receipt without crediting a refund or destroying the obligation", async () => {
  const intentId = `reverted-${Date.now()}`;
  await createPersistedRecord(intentId);

  const quorum = new FakeQuorum();
  quorum.receipt = {
    status: "reverted",
    blockNumber: 10,
    blockHash: `0x${"ee".repeat(32)}`,
    transfers: [],
  };
  const broadcaster = new FakeBroadcaster();
  const accounting = new FakeAccounting();
  const signer = new FakeSigner();
  const { workflow, store } = buildWorkflow({ quorum, broadcaster, accounting, signer });

  const outcome = await workflow.processIntent(intentId);
  // Conservative authority: a mined-but-reverted payout is NEVER terminal, so it
  // cannot erase the debt. The signed obligation is retained and the route is
  // frozen for explicit operator resolution.
  expect(outcome.action).toBe("blocked_reverted");
  expect(outcome.state).toBe("PERSISTED");

  const record = (await store.get(intentId))!;
  expect(record.state).toBe("PERSISTED");
  expect(record.signedRawTx).toBeTruthy();
  expect(hasExactPersistedBytes(record)).toBe(true);
  // No automatic refund/credit ever occurred.
  expect(accounting.completed).toHaveLength(0);
  expect(accounting.obligations).toHaveLength(0);
  expect(signer.calls).toBe(0);

  const incidents = await ctx.app.prisma.financialIncident.findMany({
    where: { assetId, kind: "CUSTODY_FAILURE" },
  });
  expect(incidents.length).toBeGreaterThan(0);

  const asset = await ctx.app.prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
  expect(asset.status).toBe("FROZEN");
});
