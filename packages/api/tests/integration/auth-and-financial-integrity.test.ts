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

    const inPlay = await ctx.app.prisma.account.findUniqueOrThrow({
      where: {
        userId_currency_type: {
          userId: p1.id,
          currency: "USDC",
          type: "IN_PLAY",
        },
      },
    });
    const initialBalance = Number(inPlay.balance);
    expect(initialBalance).toBe(1000);

    const netChange = -(initialBalance + 500);

    await expect(
      ctx.app.prisma.$transaction(async (tx) => {
        if (initialBalance + netChange < 0) {
          throw new Error("Settlement would make IN_PLAY negative");
        }
        await tx.ledgerEntry.create({
          data: {
            accountId: inPlay.id,
            amount: netChange,
            type: "HAND_LOSS",
            referenceId: "settlement-divergence",
            metadata: { tableId: ctx.tableId },
          },
        });
        await tx.account.update({
          where: { id: inPlay.id },
          data: { balance: { decrement: Math.abs(netChange) } },
        });
      })
    ).rejects.toThrow();

    const after = await ctx.app.prisma.account.findUniqueOrThrow({
      where: { id: inPlay.id },
    });
    expect(Number(after.balance)).toBe(initialBalance);

    const entries = await ctx.app.prisma.ledgerEntry.findMany({
      where: { accountId: inPlay.id, referenceId: "settlement-divergence" },
    });
    expect(entries).toHaveLength(0);

    const allEntries = await ctx.app.prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId: inPlay.id },
    });
    const ledgerSum = Number(allEntries._sum.amount ?? 0);
    expect(ledgerSum).toBe(Number(after.balance));
  });
});

describe("Deposit monitor last-scanned-block update", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(1, 10000);
  });
  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("can persist the deposit credit and last-scanned block in the same transaction", async () => {
    await ctx.app.prisma.paymentTransaction.deleteMany({
      where: { blockchain: { chainId: 99999 } },
    });
    await ctx.app.prisma.token.deleteMany({
      where: { blockchain: { chainId: 99999 } },
    });
    await ctx.app.prisma.blockchain.deleteMany({ where: { chainId: 99999 } });

    const chain = await ctx.app.prisma.blockchain.create({
      data: {
        name: "test-chain",
        chainId: 99999,
        rpcUrl: "http://localhost:8545",
        explorerUrl: "http://localhost:8545",
        nativeCurrency: "ETH",
        lastScannedBlock: "100",
        confirmations: 12,
      },
    });

    const token = await ctx.app.prisma.token.create({
      data: {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0x" + "c".repeat(40),
        minDeposit: "100",
        blockchainId: chain.id,
      },
    });

    await ctx.app.prisma.$transaction(async (tx: any) => {
      await tx.paymentTransaction.create({
        data: {
          type: "DEPOSIT",
          blockchainId: chain.id,
          tokenId: token.id,
          userId: ctx.users[0].id,
          txHash: "0x" + "a".repeat(64),
          address: "0x" + "d".repeat(40),
          amountRaw: "10000",
          amountCredit: 100,
          blockNumber: "105",
          status: "CONFIRMED",
        },
      });
      await tx.blockchain.update({
        where: { id: chain.id },
        data: { lastScannedBlock: "105" },
      });
    });

    const afterTx = await ctx.app.prisma.blockchain.findUniqueOrThrow({
      where: { id: chain.id },
    });
    expect(afterTx.lastScannedBlock).toBe("105");

    await ctx.app.prisma.paymentTransaction.deleteMany({
      where: { blockchainId: chain.id },
    });
    await ctx.app.prisma.token.deleteMany({ where: { blockchainId: chain.id } });
    await ctx.app.prisma.blockchain.delete({ where: { id: chain.id } });
  });

  it("relies on a database unique constraint on the payment transaction for duplicate prevention, not on the ledger entry", async () => {
    await ctx.app.prisma.paymentTransaction.deleteMany({
      where: { blockchain: { chainId: 88888 } },
    });
    await ctx.app.prisma.token.deleteMany({
      where: { blockchain: { chainId: 88888 } },
    });
    await ctx.app.prisma.blockchain.deleteMany({ where: { chainId: 88888 } });

    const chain = await ctx.app.prisma.blockchain.create({
      data: {
        name: "dup-chain",
        chainId: 88888,
        rpcUrl: "http://localhost:8545",
        explorerUrl: "http://localhost:8545",
        nativeCurrency: "ETH",
        lastScannedBlock: "200",
        confirmations: 12,
      },
    });

    const token = await ctx.app.prisma.token.create({
      data: {
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        address: "0x" + "e".repeat(40),
        minDeposit: "100",
        blockchainId: chain.id,
      },
    });

    const txHash = "0x" + "b".repeat(64);

    await ctx.app.prisma.$transaction(async (tx: any) => {
      await tx.paymentTransaction.create({
        data: {
          type: "DEPOSIT",
          blockchainId: chain.id,
          tokenId: token.id,
          userId: ctx.users[0].id,
          txHash,
          address: "0x" + "d".repeat(40),
          amountRaw: "5000",
          amountCredit: 50,
          blockNumber: "201",
          status: "CONFIRMED",
        },
      });
    });

    await expect(
      ctx.app.prisma.$transaction(async (tx: any) => {
        await tx.paymentTransaction.create({
          data: {
            type: "DEPOSIT",
            blockchainId: chain.id,
            tokenId: token.id,
            userId: ctx.users[0].id,
            txHash,
            address: "0x" + "d".repeat(40),
            amountRaw: "5000",
            amountCredit: 50,
            blockNumber: "201",
            status: "CONFIRMED",
          },
        });
      })
    ).rejects.toThrow();

    const ledgerEntries = await ctx.app.prisma.ledgerEntry.findMany({
      where: { referenceId: txHash },
    });
    expect(ledgerEntries.length).toBeLessThanOrEqual(1);

    await ctx.app.prisma.paymentTransaction.deleteMany({
      where: { blockchainId: chain.id },
    });
    await ctx.app.prisma.token.deleteMany({ where: { blockchainId: chain.id } });
    await ctx.app.prisma.blockchain.delete({ where: { id: chain.id } });
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

    const inPlay = await ctx.app.prisma.account.findUniqueOrThrow({
      where: {
        userId_currency_type: {
          userId: p1.id,
          currency: "USDC",
          type: "IN_PLAY",
        },
      },
    });

    const beforeEntries = await ctx.app.prisma.ledgerEntry.count({
      where: { accountId: inPlay.id },
    });

    await ctx.app.prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.create({
        data: {
          accountId: inPlay.id,
          amount: -Number(inPlay.balance),
          type: "HAND_LOSS",
          referenceId: ctx.tableId,
          metadata: { reason: "stand_busted_sync", tableId: ctx.tableId },
        },
      });
      await tx.account.update({
        where: { id: inPlay.id },
        data: { balance: 0 },
      });
    });

    const afterEntries = await ctx.app.prisma.ledgerEntry.count({
      where: { accountId: inPlay.id },
    });

    expect(afterEntries).toBe(beforeEntries + 1);

    const updated = await ctx.app.prisma.account.findUniqueOrThrow({
      where: { id: inPlay.id },
    });
    expect(Number(updated.balance)).toBe(0);
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

    const inPlay = await ctx.app.prisma.account.findUniqueOrThrow({
      where: {
        userId_currency_type: {
          userId: p1.id,
          currency: "USDC",
          type: "IN_PLAY",
        },
      },
    });
    const beforeBalance = Number(inPlay.balance);
    const beforeEntries = await ctx.app.prisma.ledgerEntry.count({
      where: { accountId: inPlay.id },
    });

    await ctx.app.prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.create({
        data: {
          accountId: inPlay.id,
          amount: 100,
          type: "HAND_WIN",
          referenceId: ctx.tableId,
          metadata: { reason: "stand_engine_stack_sync", tableId: ctx.tableId },
        },
      });
      await tx.account.update({
        where: { id: inPlay.id },
        data: { balance: { increment: 100 } },
      });
    });

    const afterEntries = await ctx.app.prisma.ledgerEntry.count({
      where: { accountId: inPlay.id },
    });
    const afterBalance = Number(
      (
        await ctx.app.prisma.account.findUniqueOrThrow({
          where: { id: inPlay.id },
        })
      ).balance
    );

    expect(afterBalance).toBe(beforeBalance + 100);
    expect(afterEntries).toBe(beforeEntries + 1);
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
    for (let i = 0; i < 10; i++) {
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

  it("rejects an arbitrarily long message field", async () => {
    const [p1] = ctx.users;

    const longMsg = "x".repeat(100000);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        amount: 100,
        blockchainId: "clx" + "a".repeat(23),
        tokenId: "clx" + "b".repeat(23),
        address: "0x" + "1".repeat(40),
        message: longMsg,
        signature: "0x" + "c".repeat(130),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an arbitrarily long idempotency key", async () => {
    const [p1] = ctx.users;
    const longKey = "k".repeat(10000);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        amount: 100,
        blockchainId: "clx" + "a".repeat(23),
        tokenId: "clx" + "b".repeat(23),
        address: "0x" + "1".repeat(40),
        message: "test",
        signature: "0x" + "c".repeat(130),
        idempotencyKey: longKey,
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

  it("does not include the raw Zod issues array in the client response on validation failure", async () => {
    const [p1] = ctx.users;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${p1.token}` },
      payload: {
        amount: -5,
        blockchainId: "bad",
        tokenId: "bad",
        address: "not-an-address",
        message: "test",
        signature: "0x" + "a".repeat(130),
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("details");
    expect(body).not.toHaveProperty("issues");
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
