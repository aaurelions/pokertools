/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { Prisma } from "../../generated/prisma/index.js";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  getTableState,
  getUserBalances,
  cleanupTestTable,
  cleanupTestUser,
  createTestUser,
  type TestContext,
} from "../helpers/test-utils.js";

describe("Chaos & Resilience", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  // ---------------------------------------------------------------------------
  // Test 1: Recover table state from DB when Redis is flushed
  // ---------------------------------------------------------------------------
  it("should recover table state from DB when Redis is flushed", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Recovery RedFlush",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);
      await buyIn(ctx.app, player2.token, tableId, 1000, 1);

      const redisKey = `table:${tableId}`;

      // Verify state exists in Redis
      const redisBefore = await ctx.app.redis.get(redisKey);
      expect(redisBefore).not.toBeNull();

      // Completely flush Redis (simulate crash/restart)
      await ctx.app.redis.flushdb();

      // Verify Redis is empty
      const redisAfter = await ctx.app.redis.get(redisKey);
      expect(redisAfter).toBeNull();

      // getTableState should recover from DB fallback
      const state = await getTableState(ctx.app, player1.token, tableId);
      expect(state.players).toBeDefined();

      const player1InState = state.players.find((p: { id: string } | null) => p?.id === player1.id);
      const player2InState = state.players.find((p: { id: string } | null) => p?.id === player2.id);
      expect(player1InState).not.toBeNull();
      expect(player2InState).not.toBeNull();

      // Verify state was repopulated in Redis after DB fallback read
      const redisRepopulated = await ctx.app.redis.get(redisKey);
      expect(redisRepopulated).not.toBeNull();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: Maintain double-entry ledger integrity after buy-in failure
  // ---------------------------------------------------------------------------
  it("should maintain double-entry ledger integrity after buy-in failure rollback", async () => {
    const [player1] = ctx.users;

    // Create a user with limited balance to guarantee buy-in failure
    const poorUser = await ctx.app.prisma.user.create({
      data: {
        username: `poor_resilience_${Date.now()}`,
        address: `0xpoor_resilience_${Date.now()}`,
        accounts: {
          create: [{ currency: "USDC", type: "MAIN", balance: 500 }],
        },
      },
    });

    const jti = `resilience_jti_${Date.now()}`;
    const poorToken = await ctx.app.jwt.sign(
      { userId: poorUser.id, address: poorUser.address, jti },
      { jti, expiresIn: "1h" }
    );

    await ctx.app.prisma.session.create({
      data: { userId: poorUser.id, jti, expiresAt: new Date(Date.now() + 3600000) },
    });

    try {
      const tableId = await createTable(ctx.app, player1.token, {
        name: "Ledger Rollback",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxBuyIn: 10000,
      });

      try {
        // Capture ledger count before attempting buy-in
        const ledgerBefore = await ctx.app.prisma.ledgerEntry.count({
          where: { account: { userId: poorUser.id } },
        });

        // Attempt buy-in with amount exceeding balance (500 > available 500)
        const buyInRes = await ctx.app.inject({
          method: "POST",
          url: `/tables/${tableId}/buy-in`,
          headers: { authorization: `Bearer ${poorToken}` },
          payload: {
            amount: 5000,
            seat: 0,
            idempotencyKey: crypto.randomUUID(),
          },
        });

        // Must fail - insufficient funds
        expect([400, 500]).toContain(buyInRes.statusCode);

        // Verify no phantom ledger entries were left behind
        const ledgerAfter = await ctx.app.prisma.ledgerEntry.count({
          where: { account: { userId: poorUser.id } },
        });
        expect(ledgerAfter).toBe(ledgerBefore);

        // Verify user's balance is completely unchanged
        const balances = await getUserBalances(ctx.app, poorUser.id);
        expect(balances.main).toBe(500);
        expect(balances.inPlay).toBe(0);

        // Also verify no partial IN_PLAY account was created
        const inPlayAccount = await ctx.app.prisma.account.findFirst({
          where: { userId: poorUser.id, type: "IN_PLAY" },
        });
        expect(inPlayAccount).toBeNull();
      } finally {
        await cleanupTestTable(ctx.app, tableId);
      }
    } finally {
      await cleanupTestUser(ctx.app, poorUser.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: Handle Redis lock acquisition failure gracefully
  // ---------------------------------------------------------------------------
  it("should handle Redis lock acquisition failure gracefully", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Lock Failure",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);
      await buyIn(ctx.app, player2.token, tableId, 1000, 1);

      // Manually acquire the same lock key that the stand endpoint uses
      const lock = await ctx.app.redlock.acquire([`lock:table:${tableId}`], 60000);

      try {
        // Try a table operation that requires the lock - must fail
        const res = await ctx.app.inject({
          method: "POST",
          url: `/tables/${tableId}/stand`,
          headers: { authorization: `Bearer ${player1.token}` },
        });
        // The stand endpoint should fail because it cannot acquire the lock
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await lock.release();
      }

      // After releasing the manual lock, a stand operation should succeed
      const standRes = await ctx.app.inject({
        method: "POST",
        url: `/tables/${tableId}/stand`,
        headers: { authorization: `Bearer ${player2.token}` },
      });
      expect(standRes.statusCode).toBe(200);

      // Verify player2 is no longer in the table state
      const state = await getTableState(ctx.app, player1.token, tableId);
      const player2InState = state.players.find((p: { id: string } | null) => p?.id === player2.id);
      expect(player2InState || null).toBeNull();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Recover from partial state loss (Redis down, DB up)
  // ---------------------------------------------------------------------------
  it("should recover from partial state loss (Redis down, DB up)", async () => {
    const [player1] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Partial Loss",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);

      const redisKey = `table:${tableId}`;

      // Verify Redis has the state
      const redisBefore = await ctx.app.redis.get(redisKey);
      expect(redisBefore).not.toBeNull();

      // Delete only the Redis key (simulate Redis data-loss incident)
      await ctx.app.redis.del(redisKey);

      // Verify Redis key is gone
      expect(await ctx.app.redis.get(redisKey)).toBeNull();

      // Immediately query state - should fallback to DB and return valid state
      const state = await getTableState(ctx.app, player1.token, tableId);
      expect(state).toBeDefined();
      const player = state.players.find((p: { id: string } | null) => p?.id === player1.id);
      expect(player).not.toBeNull();
      expect(player!.stack).toBeGreaterThan(0);

      // Verify the state was re-cached back into Redis after the DB fallback
      const redisAfter = await ctx.app.redis.get(redisKey);
      expect(redisAfter).not.toBeNull();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: Maintain consistent state across multiple Redis flush/recover cycles
  // ---------------------------------------------------------------------------
  it("should maintain consistent state across multiple Redis flush/recover cycles", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Multi-Flush Recover",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);
      await buyIn(ctx.app, player2.token, tableId, 1000, 1);

      // Record baseline state
      const state1 = await getTableState(ctx.app, player1.token, tableId);
      const playersInState1 = state1.players.filter((p: { id: string } | null) => p !== null);
      expect(playersInState1.length).toBe(2);

      // ---- Cycle 1: Flush Redis, recover via DB ----
      await ctx.app.redis.flushdb();
      const state2 = await getTableState(ctx.app, player1.token, tableId);
      const playersInState2 = state2.players.filter((p: { id: string } | null) => p !== null);
      expect(playersInState2.length).toBe(2);

      // ---- Cycle 2: Flush Redis again, recover again ----
      await ctx.app.redis.flushdb();
      const state3 = await getTableState(ctx.app, player1.token, tableId);
      const playersInState3 = state3.players.filter((p: { id: string } | null) => p !== null);
      expect(playersInState3.length).toBe(2);

      // ---- Cycle 3: Flush, then play a game action (DEAL + FOLD) ----
      await ctx.app.redis.flushdb();
      // getTableState first to repopulate Redis (needed so the Lua version
      // check in processAction finds the key it expects)
      const state4 = await getTableState(ctx.app, player1.token, tableId);
      expect(state4.players.filter((p: { id: string } | null) => p !== null).length).toBe(2);

      // Deal a hand
      await executeAction(ctx.app, player1.token, tableId, { type: "DEAL" });

      // Play a FOLD by the acting player after the deal (always legal)
      const stateAfterDeal = await getTableState(ctx.app, player1.token, tableId);
      if (stateAfterDeal.actionTo !== null && stateAfterDeal.actionTo !== undefined) {
        const actingPlayerToken = stateAfterDeal.actionTo === 0 ? player1.token : player2.token;
        await executeAction(ctx.app, actingPlayerToken, tableId, { type: "FOLD" });
      }

      // Verify state is still valid after action through recovery
      const stateFinal = await getTableState(ctx.app, player1.token, tableId);
      expect(stateFinal.street).toBeTruthy();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 6: Preserve idempotency records across Redis disruption
  // ---------------------------------------------------------------------------
  it("should preserve idempotency records across Redis disruption", async () => {
    // Create a fresh user with known balance to avoid cumulative effects
    const freshPlayer = await createTestUser(ctx.app, "idempotency_fresh", 10000);

    try {
      const tableId = await createTable(ctx.app, freshPlayer.token, {
        name: "Idempotency Redis",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
      });

      try {
        const idemKey = crypto.randomUUID();

        // First buy-in with custom idempotency key
        const res1 = await ctx.app.inject({
          method: "POST",
          url: `/tables/${tableId}/buy-in`,
          headers: { authorization: `Bearer ${freshPlayer.token}` },
          payload: { amount: 800, seat: 0, idempotencyKey: idemKey },
        });
        expect(res1.statusCode).toBe(200);

        // Verify balances after first buy-in
        const balances1 = await getUserBalances(ctx.app, freshPlayer.id);
        expect(balances1.main).toBe(9200); // 10000 - 800
        expect(balances1.inPlay).toBe(800);

        // Flush Redis completely
        await ctx.app.redis.flushdb();

        // Attempt the same buy-in with the same idempotency key
        // Idempotency is DB-backed, so it should survive Redis disruption
        const res2 = await ctx.app.inject({
          method: "POST",
          url: `/tables/${tableId}/buy-in`,
          headers: { authorization: `Bearer ${freshPlayer.token}` },
          payload: { amount: 800, seat: 0, idempotencyKey: idemKey },
        });
        expect(res2.statusCode).toBe(200);

        // Verify no double debit occurred - balance unchanged from after first buy-in
        const balances2 = await getUserBalances(ctx.app, freshPlayer.id);
        expect(balances2.main).toBe(9200);
        expect(balances2.inPlay).toBe(800);

        // Try with different amount on same key - must be rejected (conflict)
        const res3 = await ctx.app.inject({
          method: "POST",
          url: `/tables/${tableId}/buy-in`,
          headers: { authorization: `Bearer ${freshPlayer.token}` },
          payload: { amount: 400, seat: 0, idempotencyKey: idemKey },
        });
        expect(res3.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await cleanupTestTable(ctx.app, tableId);
      }
    } finally {
      await cleanupTestUser(ctx.app, freshPlayer.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 7: Handle rapid lock acquisition and release without resource leaks
  // ---------------------------------------------------------------------------
  it("should handle rapid lock acquisition and release without resource leaks", async () => {
    const [player1] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Lock Churn",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);

      const lockKey = `lock:table:${tableId}`;

      // Rapidly acquire and release the redlock 10 times
      for (let i = 0; i < 10; i++) {
        const lock = await ctx.app.redlock.acquire([lockKey], 10000);
        expect(lock).toBeDefined();
        await lock.release();
      }

      // After rapid churn, verify we can still acquire the lock
      const finalLock = await ctx.app.redlock.acquire([lockKey], 10000);
      expect(finalLock).toBeDefined();

      // Release and verify normal table operations still work
      await finalLock.release();

      const state = await getTableState(ctx.app, player1.token, tableId);
      const player = state.players.find((p: { id: string } | null) => p?.id === player1.id);
      expect(player).not.toBeNull();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 8: Maintain balance consistency when table state is lost and recreated
  // ---------------------------------------------------------------------------
  it("should maintain balance consistency when table state is lost and recreated", async () => {
    // Create a fresh user with known balance to avoid cumulative effects
    const freshPlayer = await createTestUser(ctx.app, "balance_consist_fresh", 10000);

    try {
      // Record initial balance
      const initialBalances = await getUserBalances(ctx.app, freshPlayer.id);
      expect(initialBalances.main).toBe(10000);
      expect(initialBalances.inPlay).toBe(0);

      // ---- Phase 1: Create table and buy in ----
      const tableId1 = await createTable(ctx.app, freshPlayer.token, {
        name: "Lost State",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
      });

      await buyIn(ctx.app, freshPlayer.token, tableId1, 1000, 0);

      const afterBuyIn = await getUserBalances(ctx.app, freshPlayer.id);
      expect(afterBuyIn.main).toBe(9000);
      expect(afterBuyIn.inPlay).toBe(1000);

      // ---- Phase 2: Simulate catastrophic state loss ----
      // Delete both the Redis hot cache and the DB state column
      const redisKey = `table:${tableId1}`;
      await ctx.app.redis.del(redisKey);

      await ctx.app.prisma.table.update({
        where: { id: tableId1 },
        data: { state: Prisma.DbNull },
      });

      // ---- Phase 3: Query the table - must get a graceful error ----
      const queryRes = await ctx.app.inject({
        method: "GET",
        url: `/tables/${tableId1}`,
        headers: { authorization: `Bearer ${freshPlayer.token}` },
      });
      // loadSnapshot throws NotFoundError("Table state") → 404
      expect(queryRes.statusCode).toBe(404);
      const queryBody = JSON.parse(queryRes.body);
      expect(queryBody.error || queryBody.code || "").toMatch(/not.?found/i);

      // ---- Phase 4: Clean up the broken table ----
      await cleanupTestTable(ctx.app, tableId1);

      // ---- Phase 5: Create a new table and buy in ----
      const tableId2 = await createTable(ctx.app, freshPlayer.token, {
        name: "New After Loss",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
      });

      try {
        await buyIn(ctx.app, freshPlayer.token, tableId2, 500, 0);

        // ---- Phase 6: Verify financial integrity ----
        const finalBalances = await getUserBalances(ctx.app, freshPlayer.id);
        // MAIN: 9000 (after first buy-in) - 500 (second buy-in) = 8500
        expect(finalBalances.main).toBe(8500);
        // IN_PLAY: 1000 (orphaned from first table) + 500 (second buy-in) = 1500
        expect(finalBalances.inPlay).toBe(1500);

        // Verify total money is conserved (no phantom creation/destruction).
        // First buy-in money remains in IN_PLAY because it was transferred by
        // financialManager.buyIn via a Prisma transaction that succeeded before
        // the table state was deleted. This is accounted but orphaned.
        const totalAfter = finalBalances.main + finalBalances.inPlay;
        expect(totalAfter).toBe(10000);
      } finally {
        await cleanupTestTable(ctx.app, tableId2);
      }
    } finally {
      await cleanupTestUser(ctx.app, freshPlayer.id);
    }
  });
});
