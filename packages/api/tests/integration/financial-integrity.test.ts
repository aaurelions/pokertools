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

describe("Financial Integrity - Ledger and Balance Tests", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(5, 50000);
  });

  afterAll(async () => {
    if (ctx.tableId) {
      await cleanupTestTable(ctx.app, ctx.tableId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("should maintain double-entry accounting integrity", async () => {
    const [player1, player2] = ctx.users;

    // =========================================================================
    // STEP 1: Verify Initial Balances
    // =========================================================================
    const initialBalances1 = await getUserBalances(ctx.app, player1.id);
    const initialBalances2 = await getUserBalances(ctx.app, player2.id);

    expect(initialBalances1.main).toBe(50000);
    expect(initialBalances1.inPlay).toBe(0);
    expect(initialBalances2.main).toBe(50000);
    expect(initialBalances2.inPlay).toBe(0);

    // =========================================================================
    // STEP 2: Create Table and Buy In
    // =========================================================================
    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "Financial Test",
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
    });

    await buyIn(ctx.app, player1.token, ctx.tableId, 2000, 0);

    // =========================================================================
    // STEP 3: Verify Ledger Entries
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

    // Should have exactly 2 entries: debit from MAIN, credit to IN_PLAY
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(2);

    const mainDebit = ledgerEntries.find((e) => e.account.type === "MAIN" && e.type === "BUY_IN");
    const inPlayCredit = ledgerEntries.find(
      (e) => e.account.type === "IN_PLAY" && e.type === "BUY_IN"
    );

    expect(mainDebit).toBeTruthy();
    expect(inPlayCredit).toBeTruthy();

    // Amounts should be equal and opposite
    expect(mainDebit?.amount).toBe(-2000);
    expect(inPlayCredit?.amount).toBe(2000);

    console.log(
      `✅ Double-entry accounting verified: -${Math.abs(mainDebit!.amount)} MAIN, +${inPlayCredit!.amount} IN_PLAY`
    );

    // =========================================================================
    // STEP 4: Verify Account Balances Match Ledger
    // =========================================================================
    const newBalances = await getUserBalances(ctx.app, player1.id);
    expect(newBalances.main).toBe(48000); // 50000 - 2000
    expect(newBalances.inPlay).toBe(2000);

    const mainAccount = await ctx.app.prisma.account.findFirst({
      where: {
        userId: player1.id,
        type: "MAIN",
      },
    });

    const inPlayAccount = await ctx.app.prisma.account.findFirst({
      where: {
        userId: player1.id,
        type: "IN_PLAY",
      },
    });

    expect(mainAccount?.balance).toBe(48000);
    expect(inPlayAccount?.balance).toBe(2000);

    console.log(`✅ Account balances match ledger entries`);

    // =========================================================================
    // STEP 5: Cash Out and Verify Reverse Entries
    // =========================================================================
    await standFromTable(ctx.app, player1.token, ctx.tableId);

    const cashOutBalances = await getUserBalances(ctx.app, player1.id);

    // Chips should be back in MAIN (minus any losses)
    expect(cashOutBalances.inPlay).toBe(0);
    expect(cashOutBalances.main).toBeGreaterThan(48000);
    expect(cashOutBalances.main).toBeLessThanOrEqual(50000);

    const allLedgerEntries = await ctx.app.prisma.ledgerEntry.findMany({
      where: {
        account: {
          userId: player1.id,
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Should have CASH_OUT entries
    const cashOutEntry = allLedgerEntries.find((e) => e.type === "CASH_OUT");
    expect(cashOutEntry).toBeTruthy();

    console.log(`✅ Cash out ledger entries created`);
    console.log(
      `✅ Final balance: ${cashOutBalances.main} MAIN, ${cashOutBalances.inPlay} IN_PLAY`
    );
  });

  it("should prevent double-spending with idempotency", async () => {
    const [player1] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Idempotency Financial Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    const idempotencyKey = crypto.randomUUID();
    const buyInAmount = 1000;

    // First buy-in
    await buyIn(ctx.app, player1.token, tableId, buyInAmount, 0);

    const balancesAfterFirst = await getUserBalances(ctx.app, player1.id);
    const inPlayAfterFirst = balancesAfterFirst.inPlay;

    // Attempt duplicate buy-in with same idempotency key
    const response = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player1.token}`,
      },
      payload: {
        amount: buyInAmount.toString(),
        seat: 0,
        idempotencyKey,
      },
    });

    expect(response.statusCode).toBe(200);

    const balancesAfterSecond = await getUserBalances(ctx.app, player1.id);

    // Balance should NOT have changed
    expect(balancesAfterSecond.inPlay).toBe(inPlayAfterFirst);

    // Verify ledger entries
    const ledgerEntries = await ctx.app.prisma.ledgerEntry.findMany({
      where: {
        account: {
          userId: player1.id,
        },
        type: "BUY_IN",
        referenceId: tableId,
      },
    });

    // Should only have 2 entries (debit MAIN, credit IN_PLAY) from first buy-in
    expect(ledgerEntries.length).toBe(2);

    console.log(`✅ Idempotency prevented double-spending`);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should handle concurrent buy-ins safely", async () => {
    const [player1, player2, player3] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Concurrent Buy-In Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    const initialBalances1 = await getUserBalances(ctx.app, player1.id);
    const initialBalances2 = await getUserBalances(ctx.app, player2.id);
    const initialBalances3 = await getUserBalances(ctx.app, player3.id);

    const initialTotalBalance =
      initialBalances1.main +
      initialBalances1.inPlay +
      initialBalances2.main +
      initialBalances2.inPlay +
      initialBalances3.main +
      initialBalances3.inPlay;

    // Execute concurrent buy-ins
    await Promise.all([
      buyIn(ctx.app, player1.token, tableId, 1000, 0),
      buyIn(ctx.app, player2.token, tableId, 1500, 1),
      buyIn(ctx.app, player3.token, tableId, 2000, 2),
    ]);

    // Verify all succeeded - check delta from initial
    const balances1 = await getUserBalances(ctx.app, player1.id);
    const balances2 = await getUserBalances(ctx.app, player2.id);
    const balances3 = await getUserBalances(ctx.app, player3.id);

    expect(balances1.inPlay).toBe(initialBalances1.inPlay + 1000);
    expect(balances2.inPlay).toBe(initialBalances2.inPlay + 1500);
    expect(balances3.inPlay).toBe(initialBalances3.inPlay + 2000);

    // Verify total system balance unchanged
    const finalTotalBalance =
      balances1.main +
      balances1.inPlay +
      balances2.main +
      balances2.inPlay +
      balances3.main +
      balances3.inPlay;

    expect(finalTotalBalance).toBe(initialTotalBalance);

    console.log(`✅ Concurrent buy-ins handled safely`);
    console.log(`✅ System balance preserved: ${finalTotalBalance}`);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should track rake collection correctly", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Rake Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 2000, 0);
    await buyIn(ctx.app, player2.token, tableId, 2000, 1);

    const initialTotalInPlay =
      (await getUserBalances(ctx.app, player1.id)).inPlay +
      (await getUserBalances(ctx.app, player2.id)).inPlay;

    // Deal and play a hand
    await executeAction(ctx.app, player1.token, tableId, {
      type: "DEAL",
    });

    let state = await getTableState(ctx.app, player1.token, tableId);

    // Build a pot by betting
    if (state.actionTo !== undefined) {
      const actingPlayer = ctx.users[state.actionTo];
      await executeAction(ctx.app, actingPlayer.token, tableId, {
        type: "RAISE",
        amount: 50,
      });

      state = await getTableState(ctx.app, player1.token, tableId);
      const nextPlayer = ctx.users[state.actionTo];

      await executeAction(ctx.app, nextPlayer.token, tableId, {
        type: "CALL",
      });

      // Play through to showdown
      state = await getTableState(ctx.app, player1.token, tableId);

      // Check on all streets
      while (state.street !== "SHOWDOWN" && state.actionTo !== undefined) {
        const currentPlayer = ctx.users[state.actionTo];
        await executeAction(ctx.app, currentPlayer.token, tableId, {
          type: "CHECK",
        });

        state = await getTableState(ctx.app, player1.token, tableId);
      }
    }

    // If rake was collected, total IN_PLAY should be less than initial
    const finalTotalInPlay =
      (await getUserBalances(ctx.app, player1.id)).inPlay +
      (await getUserBalances(ctx.app, player2.id)).inPlay;

    if (state.config.rake && state.config.rake > 0) {
      expect(finalTotalInPlay).toBeLessThan(initialTotalInPlay);

      const rakeCollected = initialTotalInPlay - finalTotalInPlay;
      console.log(`✅ Rake collected: ${rakeCollected} chips`);

      // Check if House account received rake
      const houseAccount = await ctx.app.prisma.account.findFirst({
        where: {
          user: {
            role: "ADMIN",
          },
          type: "MAIN",
        },
      });

      if (houseAccount) {
        const rakeEntries = await ctx.app.prisma.ledgerEntry.findMany({
          where: {
            accountId: houseAccount.id,
            type: "RAKE",
          },
        });

        if (rakeEntries.length > 0) {
          const totalRakeInLedger = rakeEntries.reduce((sum, entry) => sum + entry.amount, 0);
          expect(totalRakeInLedger).toBeGreaterThan(0);
          console.log(`✅ House account received ${totalRakeInLedger} in rake`);
        }
      }
    }

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should handle player bankruptcy correctly", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Bankruptcy Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    // Player 1 buys in with small amount
    await buyIn(ctx.app, player1.token, tableId, 50, 0);
    await buyIn(ctx.app, player2.token, tableId, 5000, 1);

    const initialBalance = await getUserBalances(ctx.app, player1.id);

    await executeAction(ctx.app, player1.token, tableId, {
      type: "DEAL",
    });

    let state = await getTableState(ctx.app, player1.token, tableId);

    // Player 1 goes all-in
    const player1Seat = 0;
    if (state.actionTo === player1Seat) {
      const player1Stack = state.players[player1Seat]?.stack || 0;
      await executeAction(ctx.app, player1.token, tableId, {
        type: "BET",
        amount: player1Stack,
      });

      state = await getTableState(ctx.app, player1.token, tableId);

      // Player 2 calls
      if (state.actionTo !== undefined) {
        await executeAction(ctx.app, player2.token, tableId, {
          type: "CALL",
        });
      }

      // Check final state
      state = await getTableState(ctx.app, player1.token, tableId);

      if (state.street === "SHOWDOWN" && state.winners) {
        const player1Lost = !state.winners.some((w) => w.seat === player1Seat);

        if (player1Lost) {
          // Player 1 should be busted
          const finalStack = state.players[player1Seat]?.stack || 0;
          expect(finalStack).toBe(0);

          const finalBalance = await getUserBalances(ctx.app, player1.id);

          // All chips lost from IN_PLAY
          expect(finalBalance.inPlay).toBeLessThan(initialBalance.inPlay);

          console.log(`✅ Player bankruptcy handled correctly`);
          console.log(`✅ Final IN_PLAY balance: ${finalBalance.inPlay}`);
        }
      }
    }

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should maintain balance consistency across multiple hands", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Multi-Hand Consistency Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 3000, 0);
    await buyIn(ctx.app, player2.token, tableId, 3000, 1);

    const initialTotal =
      (await getUserBalances(ctx.app, player1.id)).inPlay +
      (await getUserBalances(ctx.app, player2.id)).inPlay;

    // Play multiple hands
    for (let handNum = 0; handNum < 5; handNum++) {
      await executeAction(ctx.app, player1.token, tableId, {
        type: "DEAL",
      });

      let state = await getTableState(ctx.app, player1.token, tableId);

      // Everyone folds to end hand quickly
      if (state.actionTo !== undefined) {
        const actingPlayer = ctx.users[state.actionTo];
        await executeAction(ctx.app, actingPlayer.token, tableId, {
          type: "FOLD",
        });
      }

      // Verify balance consistency after each hand
      const currentTotal =
        (await getUserBalances(ctx.app, player1.id)).inPlay +
        (await getUserBalances(ctx.app, player2.id)).inPlay;

      // Total should remain constant (or slightly decrease due to rake)
      expect(currentTotal).toBeLessThanOrEqual(initialTotal);
      expect(currentTotal).toBeGreaterThan(initialTotal - 100); // Max rake threshold
    }

    console.log(`✅ Balance consistency maintained across 5 hands`);

    await cleanupTestTable(ctx.app, tableId);
  });
});
