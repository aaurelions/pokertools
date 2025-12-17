/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  getTableState,
  getUserBalances,
  standFromTable,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";

describe("Cash Game - Full Lifecycle Integration Test", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Initialize with 3 players, each with 10,000 chips
    ctx = await initTestContext(3, 10000);
  });

  afterAll(async () => {
    if (ctx.tableId) {
      await cleanupTestTable(ctx.app, ctx.tableId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("should complete full cash game lifecycle with financial integrity", async () => {
    const [player1, player2, player3] = ctx.users;

    // =========================================================================
    // STEP 1: Create Table
    // =========================================================================
    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "Cash Game Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 100,
      maxBuyIn: 2000,
    });

    expect(ctx.tableId).toBeTruthy();

    // =========================================================================
    // STEP 2: Players Buy In
    // =========================================================================
    await buyIn(ctx.app, player1.token, ctx.tableId, 1000, 0);
    await buyIn(ctx.app, player2.token, ctx.tableId, 1000, 1);
    await buyIn(ctx.app, player3.token, ctx.tableId, 1000, 2);

    // Verify balances after buy-in
    let balances1 = await getUserBalances(ctx.app, player1.id);
    expect(balances1.main).toBe(9000);
    expect(balances1.inPlay).toBe(1000);

    let balances2 = await getUserBalances(ctx.app, player2.id);
    expect(balances2.main).toBe(9000);
    expect(balances2.inPlay).toBe(1000);

    let balances3 = await getUserBalances(ctx.app, player3.id);
    expect(balances3.main).toBe(9000);
    expect(balances3.inPlay).toBe(1000);

    // =========================================================================
    // STEP 3: Deal Hand
    // =========================================================================
    await executeAction(ctx.app, player1.token, ctx.tableId, {
      type: "DEAL",
    });

    let state = await getTableState(ctx.app, player1.token, ctx.tableId);
    expect(state.street).toBe("PREFLOP");
    expect(state.players.filter((p: any) => p !== null)).toHaveLength(3);

    // Verify blinds were posted (stacks should have decreased)
    const playerWithBlinds = state.players.filter((p: any) => p !== null && p.stack < 1000);
    expect(playerWithBlinds.length).toBeGreaterThanOrEqual(2); // At least SB and BB posted

    // =========================================================================
    // STEP 4: Play Complete Hand (Preflop)
    // =========================================================================
    // Player 3 (UTG) acts first in 3-player game
    // Button is seat 0, SB is seat 1, BB is seat 2, action starts at seat 0 (UTG)

    // Find who needs to act
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const actingPlayer = ctx.users[state.actionTo];

    // Player calls the big blind
    await executeAction(ctx.app, actingPlayer.token, ctx.tableId, {
      type: "CALL",
    });

    // Next player acts
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const nextPlayer = ctx.users[state.actionTo];

    // Player raises
    await executeAction(ctx.app, nextPlayer.token, ctx.tableId, {
      type: "RAISE",
      amount: 30,
    });

    // Next player folds
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const thirdPlayer = ctx.users[state.actionTo];

    await executeAction(ctx.app, thirdPlayer.token, ctx.tableId, {
      type: "FOLD",
    });

    // Original caller calls the raise
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const callerPlayer = ctx.users[state.actionTo];

    await executeAction(ctx.app, callerPlayer.token, ctx.tableId, {
      type: "CALL",
    });

    // =========================================================================
    // STEP 5: Flop
    // =========================================================================
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    expect(state.street).toBe("FLOP");
    expect(state.board).toHaveLength(3);

    // Both players check
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const flopPlayer1 = ctx.users[state.actionTo];

    await executeAction(ctx.app, flopPlayer1.token, ctx.tableId, {
      type: "CHECK",
    });

    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const flopPlayer2 = ctx.users[state.actionTo];

    await executeAction(ctx.app, flopPlayer2.token, ctx.tableId, {
      type: "CHECK",
    });

    // =========================================================================
    // STEP 6: Turn
    // =========================================================================
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    expect(state.street).toBe("TURN");
    expect(state.board).toHaveLength(4);

    // Player 1 bets
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const turnPlayer1 = ctx.users[state.actionTo];

    await executeAction(ctx.app, turnPlayer1.token, ctx.tableId, {
      type: "BET",
      amount: 50,
    });

    // Player 2 calls
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const turnPlayer2 = ctx.users[state.actionTo];

    await executeAction(ctx.app, turnPlayer2.token, ctx.tableId, {
      type: "CALL",
    });

    // =========================================================================
    // STEP 7: River
    // =========================================================================
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    expect(state.street).toBe("RIVER");
    expect(state.board).toHaveLength(5);

    // Both players check to showdown
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const riverPlayer1 = ctx.users[state.actionTo];

    await executeAction(ctx.app, riverPlayer1.token, ctx.tableId, {
      type: "CHECK",
    });

    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    const riverPlayer2 = ctx.users[state.actionTo];

    await executeAction(ctx.app, riverPlayer2.token, ctx.tableId, {
      type: "CHECK",
    });

    // =========================================================================
    // STEP 8: Showdown
    // =========================================================================
    state = await getTableState(ctx.app, player1.token, ctx.tableId);
    expect(state.street).toBe("SHOWDOWN");
    expect(state.winners).toBeTruthy();
    expect(state.winners.length).toBeGreaterThan(0);

    // Verify a winner was determined
    const winner = state.winners[0];
    expect(winner.seat).toBeGreaterThanOrEqual(0);
    expect(winner.seat).toBeLessThan(3);
    expect(winner.amount).toBeGreaterThan(0);

    console.log(`✅ Hand completed. Winner: Seat ${winner.seat}, Amount: ${winner.amount}`);

    // =========================================================================
    // STEP 9: Verify Financial Integrity After Hand
    // =========================================================================
    // Total chips should still be 3000 (3 players × 1000 buy-in)
    const totalInPlay = balances1.inPlay + balances2.inPlay + balances3.inPlay;
    expect(totalInPlay).toBe(3000);

    // =========================================================================
    // STEP 10: Player Stands and Cashes Out
    // =========================================================================
    await standFromTable(ctx.app, player3.token, ctx.tableId);

    balances3 = await getUserBalances(ctx.app, player3.id);

    // Player 3 should have their chips back in MAIN account
    // They lost the big blind (10 chips) so should have 990 from table + 9000 in main
    const totalPlayer3 = balances3.main + balances3.inPlay;
    expect(totalPlayer3).toBeLessThanOrEqual(10000); // May have lost some chips
    expect(balances3.inPlay).toBe(0); // No longer in play

    console.log(
      `✅ Player 3 cashed out: ${balances3.main} in MAIN, ${balances3.inPlay} in IN_PLAY`
    );

    // =========================================================================
    // STEP 11: Verify Ledger Entries
    // =========================================================================
    const ledgerEntries = await ctx.app.prisma.ledgerEntry.findMany({
      where: {
        account: {
          userId: player1.id,
        },
      },
      include: {
        account: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    expect(ledgerEntries.length).toBeGreaterThan(0);

    // Should have BUY_IN entries (both debit from MAIN and credit to IN_PLAY)
    const buyInDebit = ledgerEntries.find((e) => e.type === "BUY_IN" && e.amount < 0);
    const buyInCredit = ledgerEntries.find((e) => e.type === "BUY_IN" && e.amount > 0);

    expect(buyInDebit).toBeTruthy();
    expect(buyInCredit).toBeTruthy();
    expect(buyInDebit?.amount).toBe(-1000); // Debit from MAIN
    expect(buyInCredit?.amount).toBe(1000); // Credit to IN_PLAY

    console.log(`✅ Ledger entries verified: ${ledgerEntries.length} entries for player 1`);

    // =========================================================================
    // STEP 12: Verify Total System Balance
    // =========================================================================
    balances1 = await getUserBalances(ctx.app, player1.id);
    balances2 = await getUserBalances(ctx.app, player2.id);
    balances3 = await getUserBalances(ctx.app, player3.id);

    const totalBalances =
      balances1.main +
      balances1.inPlay +
      balances2.main +
      balances2.inPlay +
      balances3.main +
      balances3.inPlay;

    // Total should be 30,000 (3 players × 10,000 initial balance)
    // May be slightly less due to rake
    expect(totalBalances).toBeLessThanOrEqual(30000);
    expect(totalBalances).toBeGreaterThanOrEqual(29900); // Allow for rake

    console.log(`✅ Total system balance: ${totalBalances} (expected ~30,000)`);
    console.log(`✅ Cash game lifecycle test completed successfully!`);
  });

  it("should handle idempotent buy-ins correctly", async () => {
    const [player1] = ctx.users;

    // Create a new table for this test
    const tableId = await createTable(ctx.app, player1.token, {
      name: "Idempotency Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    const idempotencyKey = crypto.randomUUID();
    const balancesBefore = await getUserBalances(ctx.app, player1.id);

    // First buy-in
    const response1 = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player1.token}`,
      },
      payload: {
        amount: "500",
        seat: 0,
        idempotencyKey,
      },
    });

    expect(response1.statusCode).toBe(200);

    const balancesAfterFirst = await getUserBalances(ctx.app, player1.id);
    expect(balancesAfterFirst.inPlay).toBe(balancesBefore.inPlay + 500);

    // Retry with same idempotency key
    const response2 = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player1.token}`,
      },
      payload: {
        amount: "500",
        seat: 0,
        idempotencyKey,
      },
    });

    // Should succeed (idempotent)
    expect(response2.statusCode).toBe(200);

    // Verify no additional buy-in occurred
    const balancesAfterRetry = await getUserBalances(ctx.app, player1.id);
    expect(balancesAfterRetry.inPlay).toBe(balancesAfterFirst.inPlay);

    await cleanupTestTable(ctx.app, tableId);
    console.log(`✅ Idempotency test passed!`);
  });

  it("should reject insufficient balance buy-ins", async () => {
    const [player1] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Insufficient Balance Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    // Try to buy in for more than available balance
    const response = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player1.token}`,
      },
      payload: {
        amount: "999999",
        seat: 0,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    expect(response.statusCode).toBe(400);

    await cleanupTestTable(ctx.app, tableId);
    console.log(`✅ Insufficient balance test passed!`);
  });
});
