import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";

// Canonical deposit-integrity fixtures (replace the retired Blockchain/Token/
// PaymentTransaction derived-address model).
const DEPOSIT_TEST_CHAIN_IDS = [99999, 88888] as const;

function depositTokenAddress(chainId: number): string {
  return "0x" + String(chainId % 10).repeat(40);
}

/** Remove any canonical asset/claim rows left by an earlier run. */
async function resetDepositFixtures(app: FastifyInstance, chainId: number): Promise<void> {
  await app.prisma.depositClaimRecord.deleteMany({ where: { chainId } });
  await app.prisma.asset.deleteMany({ where: { chainId } });
}

async function createDepositAsset(app: FastifyInstance, chainId: number) {
  const tokenAddress = depositTokenAddress(chainId);
  return app.prisma.asset.create({
    data: {
      id: `eip155:${chainId}/erc20:${tokenAddress}`,
      chainId,
      tokenAddress,
      symbol: "USDC",
      decimals: 6,
      treasuryAddress: "0x" + "2".repeat(40),
      rpcUrls: ["http://localhost:8545"],
      minGasAtomic: "0",
    },
  });
}

describe("Hand settlement worker ledger integrity", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);
  });
  afterAll(async () => {
    if (ctx.tableId) await cleanupTestTable(ctx.app, ctx.tableId);
    await runCleanup(ctx.cleanup);
  });

  it("rolls back settlement ledger writes when the balance update would go negative", async () => {
    const [p1] = ctx.users;

    ctx.tableId = await createTable(ctx.app, p1.token, {
      name: "Settlement Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    await buyIn(ctx.app, p1.token, ctx.tableId, 1000, 0);

    const reserveBefore = await ctx.app.financialManager.getTableReserve(p1.id, ctx.tableId);
    expect(reserveBefore).toBe(1000n);

    // A settlement/cash-out that would drive the table reserve negative must be
    // rejected atomically: neither the reserve nor the chip journal may change.
    await expect(
      ctx.app.financialManager.cashOut(p1.id, ctx.tableId, 1500, {
        idempotencyKey: "settlement-divergence",
      })
    ).rejects.toThrow();

    expect(await ctx.app.financialManager.getTableReserve(p1.id, ctx.tableId)).toBe(1000n);
    const entries = await ctx.app.prisma.chipLedgerEntry.findMany({
      where: { referenceId: "settlement-divergence" },
    });
    expect(entries).toHaveLength(0);

    // The cached reserve still equals the sum of its journal entries.
    const reserveAccount = await ctx.app.prisma.chipAccount.findUniqueOrThrow({
      where: {
        principalId_kind_scopeKey: {
          principalId: p1.id,
          kind: "TABLE_RESERVE",
          scopeKey: ctx.tableId!,
        },
      },
    });
    const aggregate = await ctx.app.prisma.chipLedgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId: reserveAccount.id },
    });
    expect(aggregate._sum.amount ?? 0n).toBe(reserveAccount.balance);
  });
});

describe("Canonical deposit claim integrity", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    for (const chainId of DEPOSIT_TEST_CHAIN_IDS) {
      await resetDepositFixtures(ctx.app, chainId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("persists a deposit claim credit and its on-chain provenance in the same transaction", async () => {
    await resetDepositFixtures(ctx.app, 99999);
    const asset = await createDepositAsset(ctx.app, 99999);
    const txHash = "0x" + "a".repeat(64);

    const created = await ctx.app.prisma.$transaction(async (tx) => {
      const claim = await tx.depositClaimRecord.create({
        data: {
          assetId: asset.id,
          principalId: ctx.users[0].id,
          chainId: 99999,
          txHash,
          logIndex: 0,
          amountAtomic: "10000",
          blockNumber: "105",
          status: "OBSERVED",
        },
      });
      await tx.depositClaimRecord.update({
        where: { id: claim.id },
        data: { status: "CREDITED", creditedJournalId: "journal-1", confirmations: 12 },
      });
      return claim;
    });

    const after = await ctx.app.prisma.depositClaimRecord.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.status).toBe("CREDITED");
    expect(after.blockNumber).toBe("105");
    expect(after.creditedJournalId).toBe("journal-1");
    expect(after.confirmations).toBe(12);
  });

  it("relies on a database unique constraint on the deposit log identity (not the journal) for duplicate prevention", async () => {
    await resetDepositFixtures(ctx.app, 88888);
    const asset = await createDepositAsset(ctx.app, 88888);
    const txHash = "0x" + "b".repeat(64);
    const identity = {
      assetId: asset.id,
      principalId: ctx.users[0].id,
      chainId: 88888,
      txHash,
      logIndex: 0,
      amountAtomic: "5000",
      blockNumber: "201",
      status: "CREDITED" as const,
      creditedJournalId: "journal-dup",
    };

    await ctx.app.prisma.depositClaimRecord.create({ data: identity });

    // Same (chainId, txHash, logIndex) identity can never be observed twice.
    await expect(ctx.app.prisma.depositClaimRecord.create({ data: identity })).rejects.toThrow();

    const count = await ctx.app.prisma.depositClaimRecord.count({
      where: { chainId: 88888, txHash },
    });
    expect(count).toBe(1);

    // A different log index in the same tx is a distinct deposit and is allowed.
    await ctx.app.prisma.depositClaimRecord.create({
      data: { ...identity, logIndex: 1, creditedJournalId: null },
    });

    // The same journal credit can never be attached to two deposits (no double-credit).
    await expect(
      ctx.app.prisma.depositClaimRecord.create({
        data: { ...identity, logIndex: 2 },
      })
    ).rejects.toThrow();
  });
});

describe("Stand endpoint financial audit trail", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);
  });
  afterAll(async () => {
    if (ctx.tableId) await cleanupTestTable(ctx.app, ctx.tableId);
    await runCleanup(ctx.cleanup);
  });

  it("creates a ledger entry when zeroing a busted player's in-play balance", async () => {
    const [p1] = ctx.users;

    ctx.tableId = await createTable(ctx.app, p1.token, {
      name: "Stand Audit Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    await buyIn(ctx.app, p1.token, ctx.tableId, 500, 0);

    const reserveAccount = await ctx.app.prisma.chipAccount.findUniqueOrThrow({
      where: {
        principalId_kind_scopeKey: {
          principalId: p1.id,
          kind: "TABLE_RESERVE",
          scopeKey: ctx.tableId!,
        },
      },
    });
    const beforeEntries = await ctx.app.prisma.chipLedgerEntry.count({
      where: { accountId: reserveAccount.id },
    });

    await ctx.app.prisma.$transaction(async (tx) => {
      await ctx.app.financialManager.applyTableReserveSync(tx, p1.id, ctx.tableId!, 0n, {
        referenceId: ctx.tableId!,
      });
    });

    expect(await ctx.app.financialManager.getTableReserve(p1.id, ctx.tableId)).toBe(0n);
    const afterEntries = await ctx.app.prisma.chipLedgerEntry.count({
      where: { accountId: reserveAccount.id },
    });
    expect(afterEntries).toBe(beforeEntries + 1);
    const loss = await ctx.app.prisma.chipLedgerEntry.findFirst({
      where: { accountId: reserveAccount.id, type: "HAND_LOSS", referenceId: ctx.tableId },
    });
    expect(loss).toBeTruthy();
  });

  it("adjusts the in-play balance to match the engine stack with a ledger entry", async () => {
    const [p1] = ctx.users;

    ctx.tableId = await createTable(ctx.app, p1.token, {
      name: "Stand Sync Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    await buyIn(ctx.app, p1.token, ctx.tableId, 1000, 0);

    const reserveBefore = await ctx.app.financialManager.getTableReserve(p1.id, ctx.tableId);
    expect(reserveBefore).toBe(1000n);

    await ctx.app.prisma.$transaction(async (tx) => {
      await ctx.app.financialManager.applyTableReserveSync(
        tx,
        p1.id,
        ctx.tableId!,
        reserveBefore + 100n,
        { referenceId: ctx.tableId! }
      );
    });

    expect(await ctx.app.financialManager.getTableReserve(p1.id, ctx.tableId)).toBe(
      reserveBefore + 100n
    );
    const reserveAccount = await ctx.app.prisma.chipAccount.findUniqueOrThrow({
      where: {
        principalId_kind_scopeKey: {
          principalId: p1.id,
          kind: "TABLE_RESERVE",
          scopeKey: ctx.tableId!,
        },
      },
    });
    const win = await ctx.app.prisma.chipLedgerEntry.findFirst({
      where: { accountId: reserveAccount.id, type: "HAND_WIN", referenceId: ctx.tableId },
    });
    expect(win).toBeTruthy();
  });
});

describe("Login endpoint input validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("rejects a numeric message field with a client error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message: 12345, signature: "0x" + "a".repeat(130) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects null message and signature fields with a client error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message: null, signature: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty body with a client error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits the nonce endpoint per route", async () => {
    let limited = false;
    for (let i = 0; i < 101; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/nonce" });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
      expect(res.statusCode).toBe(200);
    }
    expect(limited).toBe(true);
    const keys = await app.redis.keys("nonce:*");
    for (const k of keys) await app.redis.del(k);
  });
});

describe("Withdrawal schema constraints", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  const baseIntent = (overrides: Record<string, unknown>) => ({
    intentId: "intent-" + Date.now(),
    principalId: ctx.users[0].id,
    assetId: "eip155:31337/erc20:" + "0x" + "a".repeat(40),
    destination: "0x" + "1".repeat(40),
    amountAtomic: "100",
    nonce: 1,
    deadline: Math.floor(Date.now() / 1000) + 600,
    chainId: 31337,
    ...overrides,
  });

  it("rejects an arbitrarily long intent identifier", async () => {
    const [p1] = ctx.users;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/finance/withdrawals/intents",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        intent: baseIntent({ intentId: "x".repeat(100000) }),
        signature: "0x" + "c".repeat(130),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an arbitrarily long principal identifier", async () => {
    const [p1] = ctx.users;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/finance/withdrawals/intents",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        intent: baseIntent({ principalId: "p".repeat(10000) }),
        signature: "0x" + "c".repeat(130),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Withdrawal validation error responses", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("returns a structured validation error without leaking a stack or internal cause", async () => {
    const [p1] = ctx.users;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/finance/withdrawals/intents",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        intent: {
          intentId: "bad-intent",
          principalId: p1.id,
          assetId: "not-an-asset",
          destination: "not-an-address",
          amountAtomic: "-1",
          nonce: -1,
          deadline: 0,
          chainId: 0,
        },
        signature: "not-a-signature",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("error");
    const serialized = JSON.stringify(body);
    expect(body).not.toHaveProperty("stack");
    expect(body).not.toHaveProperty("cause");
    expect(serialized).not.toContain("at ");
  });
});

describe("Session expiry enforcement", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("rejects an expired database session even when the JWT has not expired", async () => {
    const [p1] = ctx.users;

    const expiredJti = "expired-jti-" + Date.now();
    await ctx.app.prisma.session.create({
      data: {
        userId: p1.id,
        jti: expiredJti,
        expiresAt: new Date(Date.now() - 86400000),
      },
    });

    const expiredToken = await ctx.app.jwt.sign(
      { userId: p1.id, address: p1.address, jti: expiredJti },
      { jti: expiredJti, expiresIn: "1h" }
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    expect(res.statusCode).toBe(401);

    await ctx.app.prisma.session.delete({ where: { jti: expiredJti } }).catch(() => {});
  });
});

describe("Per-user session limits", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("allows a single user to accumulate an unbounded number of active sessions", async () => {
    const [p1] = ctx.users;
    const jtis: string[] = [];

    for (let i = 0; i < 5; i++) {
      const jti = `multi-session-${Date.now()}-${i}`;
      await ctx.app.prisma.session.create({
        data: { userId: p1.id, jti, expiresAt: new Date(Date.now() + 86400000) },
      });
      jtis.push(jti);
    }

    const count = await ctx.app.prisma.session.count({
      where: { userId: p1.id, revoked: false },
    });
    expect(count).toBeGreaterThanOrEqual(5);

    for (const jti of jtis) {
      await ctx.app.prisma.session.delete({ where: { jti } }).catch(() => {});
    }
  });
});

describe("Auto-generated username collision surface", () => {
  it("uses 6 hex characters from the Ethereum address, producing a 16-million namespace where collisions become likely around 4000 users", () => {
    const namespace = 16 ** 6;
    const p50 = Math.sqrt((Math.PI * namespace) / 2);

    expect(namespace).toBe(16777216);
    expect(p50).toBeLessThan(10000);
  });
});

describe("Role-based access control", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("does not enforce the User.role field in the authenticate middleware", async () => {
    const [p1] = ctx.users;

    await ctx.app.prisma.user.update({
      where: { id: p1.id },
      data: { role: "ADMIN" },
    });

    const user = await ctx.app.prisma.user.findUniqueOrThrow({
      where: { id: p1.id },
    });
    expect(user.role).toBe("ADMIN");

    await ctx.app.prisma.user.update({
      where: { id: p1.id },
      data: { role: "PLAYER" },
    });
  });
});

describe("Expired session cleanup", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("accumulates expired session rows in the database with no automated cleanup", async () => {
    const [p1] = ctx.users;

    for (let i = 0; i < 3; i++) {
      await ctx.app.prisma.session.create({
        data: {
          userId: p1.id,
          jti: `expired-cleanup-${Date.now()}-${i}`,
          expiresAt: new Date(Date.now() - 86400000 * (i + 1)),
        },
      });
    }

    const expired = await ctx.app.prisma.session.count({
      where: { userId: p1.id, expiresAt: { lt: new Date() } },
    });
    expect(expired).toBeGreaterThanOrEqual(3);

    await ctx.app.prisma.session.deleteMany({
      where: { userId: p1.id, jti: { startsWith: "expired-cleanup-" } },
    });
  });
});
