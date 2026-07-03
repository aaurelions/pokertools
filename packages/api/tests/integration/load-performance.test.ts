/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
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

describe("Load and Performance Tests", () => {
  let ctx: TestContext;
  const trackedTableIds: string[] = [];
  const trackedUserIds: string[] = [];

  beforeAll(async () => {
    // Initialize with just the app — individual tests create users as needed
    ctx = await initTestContext(0);
  });

  afterAll(async () => {
    // Clean up all tables tracked during tests
    for (const tableId of trackedTableIds.reverse()) {
      try {
        await cleanupTestTable(ctx.app, tableId);
      } catch {
        // Table may have been cleaned up already
      }
    }
    // Clean up any extra users created per-test
    for (const userId of trackedUserIds.reverse()) {
      try {
        await cleanupTestUser(ctx.app, userId);
      } catch {
        // User may have been cleaned up already
      }
    }
    await runCleanup(ctx.cleanup);
  });

  function trackTable(tableId: string): string {
    trackedTableIds.push(tableId);
    return tableId;
  }

  // ===========================================================================
  // Test 1: 10 concurrent table creations
  // ===========================================================================
  it("should handle 10 concurrent table creations", { timeout: 30000 }, async () => {
    const creator = await createTestUser(ctx.app, "load_creator_1", 10000);
    trackedUserIds.push(creator.id);

    // Create 10 tables concurrently
    const promises = Array.from({ length: 10 }, (_, i) =>
      createTable(ctx.app, creator.token, {
        name: `Concurrent Table ${i}`,
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
        minBuyIn: 100,
        maxBuyIn: 2000,
      })
    );

    const tableIds = await Promise.all(promises);

    // All 10 should succeed
    expect(tableIds).toHaveLength(10);

    // All IDs should be unique
    const uniqueIds = new Set(tableIds);
    expect(uniqueIds.size).toBe(10);

    // Track for cleanup
    tableIds.forEach((id) => trackTable(id));

    // List tables and verify all 10 appear
    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/tables",
    });
    expect(listResponse.statusCode).toBe(200);

    const body = JSON.parse(listResponse.body);
    const listedIds = body.tables.map((t: { id: string }) => t.id);
    for (const tableId of tableIds) {
      expect(listedIds).toContain(tableId);
    }
  });

  // ===========================================================================
  // Test 2: 3 players performing rapid game actions (20 consecutive hands)
  // ===========================================================================
  it(
    "should handle 3 players performing rapid game actions (20 consecutive hands)",
    { timeout: 60000 },
    async () => {
      // Create 3 fresh players
      const players = await Promise.all(
        [1, 2, 3].map((n) => createTestUser(ctx.app, `rapid_player_${n}`, 10000))
      );
      players.forEach((p) => trackedUserIds.push(p.id));

      const tableId = await createTable(ctx.app, players[0].token, {
        name: "Rapid Hands Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
        minBuyIn: 100,
        maxBuyIn: 2000,
      });
      trackTable(tableId);

      // Buy in all 3 players at seats 0, 1, 2
      await buyIn(ctx.app, players[0].token, tableId, 1000, 0);
      await buyIn(ctx.app, players[1].token, tableId, 1000, 1);
      await buyIn(ctx.app, players[2].token, tableId, 1000, 2);

      const startTime = Date.now();
      let firstHandStreet = "";

      for (let hand = 0; hand < 20; hand++) {
        // Deal a new hand
        const dealResult = await executeAction(ctx.app, players[0].token, tableId, {
          type: "DEAL",
        });

        if (hand === 0) {
          firstHandStreet = dealResult.state.street;
        }

        // Verify we're in a preflop state with 3 players
        expect(dealResult.state.players.filter(Boolean)).toHaveLength(3);

        // Fold until the hand completes (winners present)
        let actionsThisHand = 0;
        const maxActionsThisHand = 10; // safety valve
        let state = dealResult.state;

        while (!state.winners || !Array.isArray(state.winners) || state.winners.length === 0) {
          actionsThisHand++;
          if (actionsThisHand > maxActionsThisHand) {
            throw new Error(
              `Hand ${hand}: exceeded max actions without completion. State: ${JSON.stringify({ street: state.street, actionTo: state.actionTo, winners: state.winners })}`
            );
          }

          // Get the player whose turn it is; if none, hand is over
          const actingSeat =
            state.actionTo !== null && state.actionTo !== undefined ? state.actionTo : -1;

          // If no player needs to act, hand is complete — break out
          if (actingSeat < 0) break;

          const actingPlayer = players[actingSeat];
          expect(actingPlayer).toBeDefined();

          // Fold
          const foldResult = await executeAction(ctx.app, actingPlayer.token, tableId, {
            type: "FOLD",
          });
          expect(foldResult.state).toBeDefined();
          state = foldResult.state;
        }

        // Hand completed — verify at least one winner or one player remaining
        const activePlayers = state.players.filter(
          (p: unknown) =>
            p !== null &&
            typeof p === "object" &&
            (p as { stack?: number }).stack &&
            (p as { stack?: number }).stack! > 0
        );
        if (state.winners && Array.isArray(state.winners) && state.winners.length > 0) {
          // Explicit winners present — verify each
          for (const winner of state.winners) {
            expect(winner.seat).toBeGreaterThanOrEqual(0);
            expect(typeof winner.amount).toBe("number");
          }
        } else {
          // No explicit winners but hand completed — verify one player standing
          expect(activePlayers.length).toBeGreaterThanOrEqual(1);
        }
      }

      const elapsed = Date.now() - startTime;

      // Verify first hand started correctly
      expect(firstHandStreet).toBe("PREFLOP");

      // All 20 hands should complete in under 15 seconds
      expect(elapsed).toBeLessThan(15000);
    }
  );

  // ===========================================================================
  // Test 3: 4 concurrent buy-ins to the same table
  // ===========================================================================
  it("should handle 4 concurrent buy-ins to the same table", { timeout: 30000 }, async () => {
    // Create 4 fresh players with known balances
    const players = await Promise.all(
      [1, 2, 3, 4].map((n) => createTestUser(ctx.app, `concurrent_buyin_${n}`, 10000))
    );
    players.forEach((p) => trackedUserIds.push(p.id));

    const creator = players[0];
    const tableId = await createTable(ctx.app, creator.token, {
      name: "Concurrent Buy-In Table",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 10,
      minBuyIn: 100,
      maxBuyIn: 2000,
    });
    trackTable(tableId);

    // Snapshot starting balances
    const startingBalances = await Promise.all(players.map((p) => getUserBalances(ctx.app, p.id)));

    // Buy in all 4 players concurrently at different seats with unique idempotency keys
    const buyInAmount = 500;
    const buyInPromises = players.map((player, i) =>
      ctx.app.inject({
        method: "POST",
        url: `/tables/${tableId}/buy-in`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: {
          amount: buyInAmount.toString(),
          seat: i,
          idempotencyKey: crypto.randomUUID(),
        },
      })
    );

    const results = await Promise.all(buyInPromises);

    // All 4 should succeed
    for (const result of results) {
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
    }

    // Verify each player's balance decreased by exactly the buy-in amount
    for (let i = 0; i < players.length; i++) {
      const balances = await getUserBalances(ctx.app, players[i].id);
      // MAIN should be reduced by buyInAmount
      expect(balances.main).toBe(startingBalances[i].main - buyInAmount);
      // IN_PLAY should be the buyInAmount (assuming no other tables)
      expect(balances.inPlay).toBe(startingBalances[i].inPlay + buyInAmount);
    }

    // Verify table state shows all 4 players seated
    const state = await getTableState(ctx.app, creator.token, tableId);
    const seatedPlayers = state.players.filter(Boolean);
    expect(seatedPlayers).toHaveLength(4);
    for (const player of seatedPlayers) {
      expect(player.stack).toBe(buyInAmount);
    }
  });

  // ===========================================================================
  // Test 4: 50 rapid idempotent buy-in requests
  // ===========================================================================
  it("should handle 50 rapid idempotent buy-in requests", { timeout: 30000 }, async () => {
    const user = await createTestUser(ctx.app, "idempotent_buyer", 10000);
    trackedUserIds.push(user.id);

    const tableId = await createTable(ctx.app, user.token, {
      name: "Idempotent Buy-In Table",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 100,
      maxBuyIn: 2000,
    });
    trackTable(tableId);

    // Snapshot starting balance
    const startBalances = await getUserBalances(ctx.app, user.id);

    // Send 50 concurrent buy-in requests with the SAME idempotency key
    const sharedIdempotencyKey = crypto.randomUUID();
    const buyInAmount = 800;
    const seat = 0;

    const requests = Array.from({ length: 50 }, () =>
      ctx.app.inject({
        method: "POST",
        url: `/tables/${tableId}/buy-in`,
        headers: { authorization: `Bearer ${user.token}` },
        payload: {
          amount: buyInAmount.toString(),
          seat,
          idempotencyKey: sharedIdempotencyKey,
        },
      })
    );

    const results = await Promise.all(requests);

    // Concurrent idempotent requests may race: some succeed (200),
    // some see conflict (409), some get rate-limited (429).
    // Key invariant: the final outcome must be exactly one buy-in.
    for (const result of results) {
      expect([200, 409, 429]).toContain(result.statusCode);
    }

    // Verify balance changed by exactly one buy-in
    const endBalances = await getUserBalances(ctx.app, user.id);
    expect(endBalances.main).toBe(startBalances.main - buyInAmount);
    expect(endBalances.inPlay).toBe(startBalances.inPlay + buyInAmount);

    // Verify exactly one player is seated
    const state = await getTableState(ctx.app, user.token, tableId);
    const seatedPlayers = state.players.filter(Boolean);
    expect(seatedPlayers).toHaveLength(1);
    expect(seatedPlayers[0].stack).toBe(buyInAmount);
  });

  // ===========================================================================
  // Test 5: Rapid table creation and immediate query
  // ===========================================================================
  it("should handle rapid table creation and immediate query", { timeout: 30000 }, async () => {
    const creator = await createTestUser(ctx.app, "rapid_creator_5", 10000);
    trackedUserIds.push(creator.id);

    const pairs: { tableId: string; state: Record<string, unknown> }[] = [];

    for (let i = 0; i < 20; i++) {
      const tableId = await createTable(ctx.app, creator.token, {
        name: `Rapid Query Table ${i}`,
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
        minBuyIn: 100,
        maxBuyIn: 2000,
      });
      trackTable(tableId);

      // Immediately query state (before any buy-in)
      const state = await getTableState(ctx.app, creator.token, tableId);

      pairs.push({ tableId, state: state as Record<string, unknown> });
    }

    // Verify all 20 tables were created with unique IDs
    const uniqueIds = new Set(pairs.map((p) => p.tableId));
    expect(uniqueIds.size).toBe(20);

    // Each table should have empty players (no buy-ins)
    for (const { state } of pairs) {
      const players = (state.players as unknown[]) || [];
      const seated = players.filter(Boolean);
      expect(seated).toHaveLength(0);
      // Street should default to PREFLOP or be undefined for empty tables
      expect(["PREFLOP", undefined, null]).toContain(state.street);
    }

    // Verify tables appear in listing
    const listResponse = await ctx.app.inject({
      method: "GET",
      url: "/tables",
    });
    expect(listResponse.statusCode).toBe(200);
    const body = JSON.parse(listResponse.body);
    for (const { tableId } of pairs) {
      const found = body.tables.find((t: { id: string }) => t.id === tableId);
      expect(found).toBeDefined();
      expect(found.status).toBe("WAITING");
    }
  });

  // ===========================================================================
  // Test 6: Tournament registration with many players
  // ===========================================================================
  it("should handle tournament registration with many players", { timeout: 60000 }, async () => {
    const creator = await createTestUser(ctx.app, "tourney_creator", 20000);
    trackedUserIds.push(creator.id);

    // Create 15 registrant users
    const registrants = await Promise.all(
      Array.from({ length: 15 }, (_, i) => createTestUser(ctx.app, `tourney_reg_${i}`, 20000))
    );
    registrants.forEach((r) => trackedUserIds.push(r.id));

    // Create tournament with maxPlayers=20
    const buyInAmount = 1000;
    const feeAmount = 50;
    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Load Test Tournament",
        buyIn: buyInAmount,
        fee: feeAmount,
        startingStack: 5000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 20,
        payoutPercentages: [60, 30, 10],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId } = JSON.parse(createResponse.body);
    expect(tournamentId).toBeTruthy();

    // Register all 15 players concurrently
    const registerPromises = registrants.map((user, i) =>
      ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${user.token}` },
        payload: {
          seat: i,
          idempotencyKey: crypto.randomUUID(),
        },
      })
    );

    const registerResults = await Promise.all(registerPromises);

    // All 15 should succeed
    for (const result of registerResults) {
      expect(result.statusCode).toBe(200);
    }

    // Verify tournament shows 15 registered players
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(detailsResponse.statusCode).toBe(200);
    const details = JSON.parse(detailsResponse.body).tournament;

    expect(details.registeredPlayers).toBe(15);

    // Prize pool = registeredPlayers × buyIn (fee does not contribute)
    const expectedPrizePool = 15 * buyInAmount;
    expect(details.prizePool).toBe(expectedPrizePool);

    // Verify each registrant's balance was correctly deducted
    for (const registrant of registrants) {
      const balances = await getUserBalances(ctx.app, registrant.id);
      expect(balances.main).toBe(20000 - buyInAmount - feeAmount);
    }

    // Verify creator balance is unchanged (did not register)
    const creatorBalances = await getUserBalances(ctx.app, creator.id);
    expect(creatorBalances.main).toBe(20000);

    // Cleanup tournament data
    try {
      await ctx.app.prisma.tournamentEntry.deleteMany({
        where: { tournamentId },
      });
      await ctx.app.prisma.tournament.delete({
        where: { id: tournamentId },
      });
    } catch {
      // Best effort cleanup
    }
  });

  // ===========================================================================
  // Test 7: Measure acceptable response times under sequential load
  // ===========================================================================
  it(
    "should measure acceptable response times under sequential load",
    { timeout: 30000 },
    async () => {
      // Create 2 players
      const player1 = await createTestUser(ctx.app, "perf_player_1", 10000);
      const player2 = await createTestUser(ctx.app, "perf_player_2", 10000);
      trackedUserIds.push(player1.id, player2.id);

      const tableId = await createTable(ctx.app, player1.token, {
        name: "Response Time Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
        minBuyIn: 100,
        maxBuyIn: 2000,
      });
      trackTable(tableId);

      // Buy in both players (helpers now retry on rate limiting)
      const t0Buy1 = performance.now();
      await buyIn(ctx.app, player1.token, tableId, 1000, 0);
      const buyIn1Duration = performance.now() - t0Buy1;

      const t0Buy2 = performance.now();
      await buyIn(ctx.app, player2.token, tableId, 1000, 1);
      const buyIn2Duration = performance.now() - t0Buy2;

      // Deal
      const t0Deal = performance.now();
      await executeAction(ctx.app, player1.token, tableId, { type: "DEAL" });
      const dealDuration = performance.now() - t0Deal;

      // Get state to find who acts first
      let state = await getTableState(ctx.app, player1.token, tableId);
      let actingSeat: number =
        state.actionTo !== null && state.actionTo !== undefined ? state.actionTo : 0;

      // Player at actingSeat folds
      const firstActor = actingSeat === 0 ? player1 : player2;
      const t0Fold1 = performance.now();
      const fold1Result = await executeAction(ctx.app, firstActor.token, tableId, { type: "FOLD" });
      const fold1Duration = performance.now() - t0Fold1;

      state = fold1Result.state;

      // If hand isn't over yet (both still in), fold for the other player
      let fold2Duration = 0;
      if (!state.winners || (Array.isArray(state.winners) && state.winners.length === 0)) {
        actingSeat = state.actionTo !== null && state.actionTo !== undefined ? state.actionTo : 0;
        const secondActor = actingSeat === 0 ? player1 : player2;

        const t0Fold2 = performance.now();
        await executeAction(ctx.app, secondActor.token, tableId, {
          type: "FOLD",
        });
        fold2Duration = performance.now() - t0Fold2;
      }

      // All individual HTTP requests should complete in under 1000ms
      const allDurations = [
        { step: "buy-in player 1", duration: buyIn1Duration },
        { step: "buy-in player 2", duration: buyIn2Duration },
        { step: "deal", duration: dealDuration },
        { step: "fold 1", duration: fold1Duration },
      ];
      if (fold2Duration > 0) {
        allDurations.push({ step: "fold 2", duration: fold2Duration });
      }

      for (const { step, duration } of allDurations) {
        expect(
          duration,
          `Step "${step}" took ${duration.toFixed(0)}ms, expected < 1000ms`
        ).toBeLessThan(1000);
      }

      // All steps should complete in less than 5000ms total (generous buffer)
      const totalDuration = allDurations.reduce((sum, d) => sum + d.duration, 0);
      expect(totalDuration).toBeLessThan(5000);
    }
  );
});
