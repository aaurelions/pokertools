/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  initTestContext,
  runCleanup,
  cleanupTestTable,
  getUserBalances,
  type TestContext,
} from "../helpers/test-utils.js";
import { getHouseUserId } from "../../src/utils/house-user.js";

describe("Tournament Edge Cases", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // 8 users: enough for 7-player max in odd-distribution test
    ctx = await initTestContext(8, 20000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  // -------------------------------------------------------------------------
  // 1. Reject registration after tournament has started
  // -------------------------------------------------------------------------
  it("should reject registration after tournament has started", async () => {
    const [creator, player2, player3] = ctx.users;

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Closed Registration Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register 2 players (enough to start)
    for (const [index, player] of [creator, player2].entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode).toBe(200);
    }

    // Start the tournament
    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(200);

    // Attempt to register a 3rd player after the tournament started
    const lateRegisterResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${player3.token}` },
      payload: { seat: 2, idempotencyKey: crypto.randomUUID() },
    });
    expect(lateRegisterResponse.statusCode).toBe(400);
    const lateBody = JSON.parse(lateRegisterResponse.body);
    // Thrown errors from idempotency wrapper use Fastify default format:
    // { statusCode, error, message }
    expect(lateBody.message).toMatch(/registration is closed/i);

    // Verify the tournament status remains RUNNING
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.status).toBe("RUNNING");
    expect(details.registeredPlayers).toBe(2);

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 2. Reject tournament start with only 1 registered player
  // -------------------------------------------------------------------------
  it("should reject tournament start with only 1 registered player", async () => {
    const [creator] = ctx.users;

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Solo Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 6,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register only the creator (1 player total)
    const registerResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${creator.token}` },
      payload: { seat: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(registerResponse.statusCode).toBe(200);

    // Verify registration succeeded
    const detailsBeforeStart = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const beforeStart = JSON.parse(detailsBeforeStart.body).tournament;
    expect(beforeStart.registeredPlayers).toBe(1);

    // Attempt to start with only 1 player
    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(400);
    const startBody = JSON.parse(startResponse.body);
    expect(startBody.error).toMatch(/TOURNAMENT_REQUIRES_TWO_PLAYERS|requires at least 2/i);

    // Tournament should still be in REGISTRATION status
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.status).toBe("REGISTRATION");

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 3. Odd-numbered player distribution across tables
  // -------------------------------------------------------------------------
  it("should correctly handle tournament with odd-numbered player distribution", async () => {
    const creator = ctx.users[0];
    // Use players 0 through 6 (7 total)
    const registrants = ctx.users.slice(0, 7);

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Odd Distribution Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 9,
        tableMaxPlayers: 3,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId } = JSON.parse(createResponse.body);

    // Register all 7 players
    for (const [index, player] of registrants.entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode).toBe(200);
    }

    // Start tournament — expect balanced distribution [3, 2, 2]
    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(200);
    const startBody = JSON.parse(startResponse.body);
    expect(startBody.success).toBe(true);
    expect(startBody.tableIds).toHaveLength(3);
    expect(startBody.distribution).toEqual([3, 2, 2]);

    const allTableIds: string[] = startBody.tableIds;

    // Verify the tournament details show 3 tables and all are ACTIVE
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.status).toBe("RUNNING");
    expect(details.tables).toHaveLength(3);

    for (const table of details.tables) {
      expect(["ACTIVE"]).toContain(table.status);
      expect(table.playerCount).toBeGreaterThan(0);
    }

    // Verify total player count across tables matches registrants
    const totalPlayersAcrossTables = details.tables.reduce(
      (sum: number, t: { playerCount: number }) => sum + t.playerCount,
      0
    );
    expect(totalPlayersAcrossTables).toBe(7);

    // Verify all entries have ACTIVE status with assigned tables
    expect(details.entries).toHaveLength(7);
    for (const entry of details.entries) {
      expect(entry.status).toBe("ACTIVE");
      expect(entry.currentTableId).toBeTruthy();
      expect(entry.currentSeat).toBeGreaterThanOrEqual(0);
    }

    // Clean up all tables
    for (const tableId of allTableIds) {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Tournament with exact max player count (perfect division)
  // -------------------------------------------------------------------------
  it("should handle tournament with exact max player count", async () => {
    const creator = ctx.users[0];
    const registrants = ctx.users.slice(0, 6);

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Full Capacity Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 1500,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 6,
        tableMaxPlayers: 3,
        payoutPercentages: [70, 30],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId } = JSON.parse(createResponse.body);

    // Register exactly 6 players (fills all seats)
    for (const [index, player] of registrants.entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode).toBe(200);
    }

    // Verify full registration
    const preStart = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const preStartBody = JSON.parse(preStart.body).tournament;
    expect(preStartBody.registeredPlayers).toBe(6);
    expect(preStartBody.prizePool).toBe(3000); // 6 × 500

    // Start tournament — expect 2 tables with 3 each
    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(200);
    const startBody = JSON.parse(startResponse.body);
    expect(startBody.success).toBe(true);
    expect(startBody.tableIds).toHaveLength(2);
    expect(startBody.distribution).toEqual([3, 3]);

    const allTableIds: string[] = startBody.tableIds;

    // Verify tournament details
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.status).toBe("RUNNING");
    expect(details.tables).toHaveLength(2);

    // Both tables should be ACTIVE with exactly 3 players
    for (const table of details.tables) {
      expect(table.status).toBe("ACTIVE");
      expect(table.playerCount).toBe(3);
    }

    // All 6 entries should be ACTIVE
    const activeEntries = details.entries.filter((e: { status: string }) => e.status === "ACTIVE");
    expect(activeEntries).toHaveLength(6);
    for (const entry of activeEntries) {
      expect(entry.currentTableId).toBeTruthy();
    }

    // Verify payout config preserved
    expect(details.payoutPercentages).toEqual([70, 30]);

    // Clean up all tables
    for (const tableId of allTableIds) {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Reject settlement when more than 1 player remains
  // -------------------------------------------------------------------------
  it("should reject tournament settlement when more than 1 active player remains", async () => {
    const [creator, player2] = ctx.users;

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Premature Settlement Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 1500,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register 2 players and start
    for (const [index, player] of [creator, player2].entries()) {
      await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
    }

    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(200);

    // Both players are still alive — settlement should be rejected
    const settleResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/settle`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(settleResponse.statusCode).toBe(400);
    const settleBody = JSON.parse(settleResponse.body);
    expect(settleBody.error).toMatch(/not complete|TOURNAMENT_NOT_COMPLETE/i);
    expect(settleBody.activePlayers).toBeGreaterThan(1);

    // Tournament should still be RUNNING
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.status).toBe("RUNNING");

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 6. Custom blind structure reaching the last level
  // -------------------------------------------------------------------------
  it("should handle tournament with custom blind structure that reaches the last level", async () => {
    const [creator, player2] = ctx.users;

    const customBlinds = [
      { smallBlind: 25, bigBlind: 50, ante: 0 },
      { smallBlind: 50, bigBlind: 100, ante: 0 },
      { smallBlind: 100, bigBlind: 200, ante: 0 },
      { smallBlind: 200, bigBlind: 400, ante: 0 },
    ];

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Blind Cap Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        blindStructure: customBlinds,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register 2 players and start
    for (const [index, player] of [creator, player2].entries()) {
      await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
    }

    await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });

    // Advance blinds 3 times (should progress through all 3 levels)
    const blindLevels: number[] = [];
    for (let i = 0; i < 3; i++) {
      const advanceResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/advance-blinds`,
        headers: { authorization: `Bearer ${creator.token}` },
      });
      expect(advanceResponse.statusCode).toBe(200);
      const advanceBody = JSON.parse(advanceResponse.body);
      const tableResult = advanceBody.results[tableId];
      expect(tableResult).toBeTruthy();

      if (tableResult.blindLevel !== undefined) {
        blindLevels.push(tableResult.blindLevel);
        expect(tableResult.blindLevel).toBe(i + 1);
      }
    }
    expect(blindLevels).toHaveLength(3);

    // Try a 4th advance — should handle gracefully (stay at last level or return error)
    const fourthAdvance = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/advance-blinds`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    // The API call itself should succeed (200), though individual table result may vary
    expect(fourthAdvance.statusCode).toBe(200);
    const fourthBody = JSON.parse(fourthAdvance.body);
    const fourthResult = fourthBody.results[tableId];

    // Verify graceful handling: either blindLevel capped at last level (3) or error reported
    if (fourthResult.error) {
      expect(fourthResult.error).toMatch(/failed/i);
    } else {
      // Engine capped at the last level (index 3 with 4-level custom structure)
      expect(fourthResult.blindLevel).toBeGreaterThanOrEqual(3);
    }

    // Verify tournament is still RUNNING
    const details = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });
    expect(details.status).toBe("RUNNING");

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 7. Enforce buy-in + fee deduction for tournament registration
  // -------------------------------------------------------------------------
  it("should enforce buy-in plus fee deduction for tournament registration", async () => {
    // Use a fresh user to avoid cumulative balance effects from previous tests
    const player = ctx.users[7]; // user #8, not used in earlier tests
    const buyIn = 500;
    const fee = 50;

    const balanceBefore = await getUserBalances(ctx.app, player.id);

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${player.token}` },
      payload: {
        name: "Fee Deduction Tournament",
        buyIn,
        fee,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register the player
    const registerResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${player.token}` },
      payload: { seat: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(registerResponse.statusCode).toBe(200);

    const balanceAfter = await getUserBalances(ctx.app, player.id);

    // Verify MAIN decreased by exactly buyIn + fee (550), not just buyIn (500)
    const expectedDeduction = buyIn + fee; // 550
    const actualDeduction = balanceBefore.main - balanceAfter.main;
    expect(actualDeduction).toBe(expectedDeduction);

    // IN_PLAY should be unchanged (tournament registration only debits MAIN)
    expect(balanceAfter.inPlay).toBe(balanceBefore.inPlay);

    // Verify the tournament's prize pool only holds buyIn (not fee)
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.prizePool).toBe(buyIn); // 500, not 550

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 8. Prize pool escrow accounting (double-entry)
  // -------------------------------------------------------------------------
  it("should verify prize pool escrow accounting (double-entry)", async () => {
    // Use fresh pair of users not depleted by earlier tests
    const creator = ctx.users[5];
    const player2 = ctx.users[6];
    const unregisteredPlayer = ctx.users[7];

    // Record baseline balances before any tournament activity
    const players = [creator, player2, unregisteredPlayer];
    const initialBalances = await Promise.all(players.map((p) => getUserBalances(ctx.app, p.id)));

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Escrow Accounting Tournament",
        buyIn: 1000,
        fee: 100,
        startingStack: 5000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register 2 players
    for (const [index, player] of [creator, player2].entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode).toBe(200);
    }

    // Check tournament prize pool — should be 2000 (2 × buyIn), NOT including fees
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    const details = JSON.parse(detailsResponse.body).tournament;
    expect(details.prizePool).toBe(2000); // 2 players × 1000 buy-in only

    // Verify each registered player's MAIN decreased by exactly 1100 (buyIn + fee)
    const registeredBalances = await Promise.all(
      [creator, player2].map((p) => getUserBalances(ctx.app, p.id))
    );
    for (let i = 0; i < 2; i++) {
      const deduction = initialBalances[i].main - registeredBalances[i].main;
      expect(deduction).toBe(1100); // 1000 buyIn + 100 fee
      expect(registeredBalances[i].inPlay).toBe(0);
    }

    // Unregistered player should have unchanged balance
    const unregisteredBalances = await getUserBalances(ctx.app, unregisteredPlayer.id);
    expect(unregisteredBalances.main).toBe(initialBalances[2].main);
    expect(unregisteredBalances.inPlay).toBe(initialBalances[2].inPlay);

    // Verify escrow account holds the total debits (2000 buyIn + 200 fee = 2200)
    // The TOURNAMENT_ESCROW account is created at seed time; if missing, total buyIn+fee
    // still shows up in the house user's ledger entries even before the account exists.
    const houseUserId = await getHouseUserId(ctx.app.prisma);
    const escrowAccount = await ctx.app.prisma.account.findUnique({
      where: {
        userId_currency_type: {
          userId: houseUserId,
          currency: "USDC",
          type: "TOURNAMENT_ESCROW",
        },
      },
    });
    if (escrowAccount) {
      // Escrow balance should reflect total buyIn + fee collected
      expect(Number(escrowAccount.balance)).toBeGreaterThanOrEqual(2200);
    }

    // Verify total system balance conservation (users' main + inPlay)
    const currentBalances = await Promise.all(players.map((p) => getUserBalances(ctx.app, p.id)));
    const usersTotalBefore = initialBalances.reduce((sum, b) => sum + b.main + b.inPlay, 0);
    const usersTotalAfter = currentBalances.reduce((sum, b) => sum + b.main + b.inPlay, 0);
    // The difference in user balances (2200) should be accounted for in escrow
    const userDelta = usersTotalBefore - usersTotalAfter;
    expect(userDelta).toBe(2200);

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 9. Blind advancement only allowed for RUNNING tournaments
  // -------------------------------------------------------------------------
  it("should handle blind advancement only when tournament is RUNNING", async () => {
    const [creator, player2] = ctx.users;

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Blind Advancement State Check",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register 2 players but do NOT start
    for (const [index, player] of [creator, player2].entries()) {
      await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
    }

    // Try to advance blinds on a REGISTRATION tournament — should fail
    const advanceBeforeStart = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/advance-blinds`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(advanceBeforeStart.statusCode).toBe(400);
    const advanceError = JSON.parse(advanceBeforeStart.body);
    expect(advanceError.error).toMatch(/TOURNAMENT_NOT_RUNNING/i);

    // Tournament status should still be REGISTRATION
    const preStartDetails = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
    });
    expect(JSON.parse(preStartDetails.body).tournament.status).toBe("REGISTRATION");

    // Now start the tournament
    const startResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(startResponse.statusCode).toBe(200);

    // advance-blinds should now work
    const advanceAfterStart = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/advance-blinds`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(advanceAfterStart.statusCode).toBe(200);
    const advanceBody = JSON.parse(advanceAfterStart.body);
    expect(advanceBody.results[tableId]).toBeTruthy();
    // Should not have an error for this table
    expect(advanceBody.results[tableId].error).toBeUndefined();

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 10. Create tournament with all optional parameters set
  // -------------------------------------------------------------------------
  it("should create tournament with all optional parameters set", async () => {
    const [creator] = ctx.users;

    const customBlindStructure = [
      { smallBlind: 10, bigBlind: 20, ante: 0 },
      { smallBlind: 25, bigBlind: 50, ante: 0 },
      { smallBlind: 50, bigBlind: 100, ante: 5 },
    ];

    const futureStartsAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
    const balancingTolerance = 2;

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Full Featured Tournament",
        buyIn: 1000,
        fee: 100,
        startingStack: 5000,
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 20,
        tableMaxPlayers: 6,
        blindStructure: customBlindStructure,
        balancingTolerance,
        startsAt: futureStartsAt,
        payoutPercentages: [70, 30],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);
    expect(tournamentId).toBeTruthy();

    // Fetch tournament details and verify all optional params are preserved
    const detailsResponse = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(detailsResponse.statusCode).toBe(200);
    const details = JSON.parse(detailsResponse.body).tournament;

    // Verify basic fields
    expect(details.name).toBe("Full Featured Tournament");
    expect(details.buyIn).toBe(1000);
    expect(details.fee).toBe(100);
    expect(details.startingStack).toBe(5000);
    expect(details.maxPlayers).toBe(20);
    expect(details.tableMaxPlayers).toBe(6);

    // Verify blindStructure preserved (3 levels, each with correct values)
    expect(details.blindStructure).toHaveLength(3);
    expect(details.blindStructure[0]).toEqual(customBlindStructure[0]);
    expect(details.blindStructure[1]).toEqual(customBlindStructure[1]);
    expect(details.blindStructure[2]).toEqual(customBlindStructure[2]);

    // Verify balancingTolerance
    expect(details.balancingTolerance).toBe(balancingTolerance);

    // Verify startsAt (should be the future ISO string or close to it)
    expect(details.startsAt).toBeTruthy();
    const parsedStartsAt = new Date(details.startsAt!).getTime();
    const expectedStartsAt = new Date(futureStartsAt).getTime();
    // Allow 5-second tolerance for serialization rounding
    expect(Math.abs(parsedStartsAt - expectedStartsAt)).toBeLessThan(5000);

    // Verify payout percentages
    expect(details.payoutPercentages).toEqual([70, 30]);

    // Tournament should be in REGISTRATION status
    expect(details.status).toBe("REGISTRATION");
    expect(details.registeredPlayers).toBe(0);
    expect(details.prizePool).toBe(0);

    await cleanupTestTable(ctx.app, tableId);
  });

  // -------------------------------------------------------------------------
  // 11. Reject registration for a seat that is already taken
  // -------------------------------------------------------------------------
  it("should reject registration for a seat that is already taken", async () => {
    // Use a fresher pair of users to avoid cumulative balance effects
    const creator = ctx.users[3];
    const player2 = ctx.users[4];

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Seat Conflict Tournament",
        buyIn: 500,
        fee: 0,
        startingStack: 2000,
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body);

    // Register creator at seat 0
    const firstRegister = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${creator.token}` },
      payload: { seat: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(firstRegister.statusCode).toBe(200);

    // Verify the seat is taken
    const detailsAfterFirst = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    const firstEntry = JSON.parse(detailsAfterFirst.body).tournament.entries[0];
    expect(firstEntry.seat).toBe(0);

    // Record player2's balance before the failed registration attempt
    const player2BalanceBefore = await getUserBalances(ctx.app, player2.id);

    // Attempt to register player2 at the same seat 0
    const duplicateSeatResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${player2.token}` },
      payload: { seat: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(duplicateSeatResponse.statusCode).toBe(409);
    const duplicateBody = JSON.parse(duplicateSeatResponse.body);
    // Thrown errors from idempotency wrapper use Fastify default format:
    // { statusCode, error, message }
    expect(duplicateBody.message).toMatch(/seat is already registered/i);

    // Still only 1 player registered
    const detailsAfterSecond = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    const afterSecond = JSON.parse(detailsAfterSecond.body).tournament;
    expect(afterSecond.registeredPlayers).toBe(1);

    // Player 2's balance should be unchanged (registration failed)
    const player2Balances = await getUserBalances(ctx.app, player2.id);
    expect(player2Balances.main).toBe(player2BalanceBefore.main);
    expect(player2Balances.inPlay).toBe(player2BalanceBefore.inPlay);

    // Player 2 should be able to register at a different seat
    const differentSeatResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${player2.token}` },
      payload: { seat: 1, idempotencyKey: crypto.randomUUID() },
    });
    expect(differentSeatResponse.statusCode).toBe(200);

    // Now 2 players registered
    const detailsFinal = await ctx.app.inject({
      method: "GET",
      url: `/tournaments/${tournamentId}`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(JSON.parse(detailsFinal.body).tournament.registeredPlayers).toBe(2);

    await cleanupTestTable(ctx.app, tableId);
  });
});
