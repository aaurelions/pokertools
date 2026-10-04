/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  getTableState,
  standFromTable,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";
import {
  executeNextHandIntent,
  type NextHandIntentPayload,
} from "../../src/workers/next-hand-handler.js";

/**
 * Next-hand identity concurrency regressions.
 *
 * The auto-deal job is bound to the table-scoped canonical identity of the hand
 * that completed (`${tableId}_${handId}`). These exercise the real GameManager
 * and the production next-hand handler against the authoritative snapshot:
 * exactly-once auto-deal after benign same-hand version movement, manual-DEAL
 * wins, stale/duplicate jobs, insufficient players, legacy payloads and the
 * winners-absent guard.
 */
describe("Next-hand identity concurrency", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(2, 20000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  function runIntent(intent: NextHandIntentPayload): Promise<void> {
    return executeNextHandIntent(ctx.app.prisma, ctx.app.gameManager, ctx.app.redlock, intent);
  }

  function sumCurrentBets(state: any): number {
    return Object.values(state.currentBets ?? {}).reduce<number>(
      (sum, value) => sum + (Number(value) || 0),
      0
    );
  }

  function tableChipTotal(state: any): number {
    const stacks = state.players.reduce(
      (sum: number, player: any) => sum + (player?.stack ?? 0),
      0
    );
    return stacks + sumCurrentBets(state);
  }

  /** The durable intent written by the completion of `handId`. */
  async function nextHandIntentFor(
    tableId: string,
    handId: string
  ): Promise<NextHandIntentPayload> {
    const row = await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `next-hand:${tableId}_${handId}` },
    });
    return row.payload as NextHandIntentPayload;
  }

  /** Create a cash table, seat two players and complete hand H1 by folding. */
  async function setupCompletedHand(name: string): Promise<{
    tableId: string;
    tokens: string[];
    showdown: any;
    intent: NextHandIntentPayload;
  }> {
    const [player1, player2] = ctx.users;
    const tableId = await createTable(ctx.app, player1.token, {
      name,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    await buyIn(ctx.app, player1.token, tableId, 1000, 0);
    await buyIn(ctx.app, player2.token, tableId, 1000, 1);
    const tokens = [player1.token, player2.token];

    await executeAction(ctx.app, tokens[0], tableId, { type: "DEAL" });
    let state = await getTableState(ctx.app, tokens[0], tableId);
    let guard = 0;
    while (state.street !== "SHOWDOWN" && guard < 20) {
      const seat = state.actionTo;
      expect(seat).toBeTypeOf("number");
      await executeAction(ctx.app, tokens[seat], tableId, { type: "FOLD" });
      state = await getTableState(ctx.app, tokens[0], tableId);
      guard += 1;
    }

    expect(state.street).toBe("SHOWDOWN");
    expect(state.winners).toBeTruthy();
    const intent = await nextHandIntentFor(tableId, state.handId);
    return { tableId, tokens, showdown: state, intent };
  }

  it("A. auto-deals exactly once after a benign same-hand version change, posting new blinds", async () => {
    const { tableId, tokens, showdown, intent } =
      await setupCompletedHand("next-hand-benign-update");
    try {
      // The committed intent carries the same table-scoped canonical identity
      // used by the dedupe key and the strict version snapshot it was built at.
      expect(intent.expectedHandId).toBe(`${tableId}_${showdown.handId}`);
      expect(intent.expectedVersion).toBe(showdown.version);

      // Benign same-hand change: the winner shows at showdown. Hand identity and
      // winners are unchanged; only the version advances.
      const winnerToken = tokens[showdown.winners[0].seat];
      await executeAction(ctx.app, winnerToken, tableId, { type: "SHOW" });
      const afterShow = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterShow.handId).toBe(showdown.handId);
      expect(afterShow.version).toBe(showdown.version + 1);
      const chipsBefore = tableChipTotal(afterShow);

      await runIntent(intent);
      const afterDeal = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterDeal.handId).not.toBe(showdown.handId);
      expect(afterDeal.street).toBe("PREFLOP");
      expect(afterDeal.handNumber).toBe(showdown.handNumber + 1);
      expect(afterDeal.version).toBe(afterShow.version + 1);
      // New blinds are posted exactly once and chips are conserved.
      expect(sumCurrentBets(afterDeal)).toBe(15);
      expect(tableChipTotal(afterDeal)).toBe(chipsBefore);

      // Replay of the same committed intent is a no-op by identity.
      await runIntent(intent);
      const afterReplay = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterReplay.handId).toBe(afterDeal.handId);
      expect(afterReplay.version).toBe(afterDeal.version);
      expect(sumCurrentBets(afterReplay)).toBe(15);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("B. a manual DEAL wins; the pending auto-deal intent is a no-op", async () => {
    const { tableId, tokens, showdown, intent } = await setupCompletedHand("next-hand-manual-deal");
    try {
      await executeAction(ctx.app, tokens[0], tableId, { type: "DEAL" });
      const manual = await getTableState(ctx.app, tokens[0], tableId);
      expect(manual.handId).not.toBe(showdown.handId);
      expect(manual.street).toBe("PREFLOP");
      expect(sumCurrentBets(manual)).toBe(15);

      await runIntent(intent);
      const after = await getTableState(ctx.app, tokens[0], tableId);
      expect(after.handId).toBe(manual.handId);
      expect(after.handNumber).toBe(manual.handNumber);
      expect(after.version).toBe(manual.version);
      expect(sumCurrentBets(after)).toBe(15);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("C. an H1 job cannot advance a table whose current hand H2 is at showdown", async () => {
    const { tableId, tokens, showdown, intent } = await setupCompletedHand("next-hand-stale-h1");
    try {
      // Manual DEAL starts H2; play it to a completed showdown.
      await executeAction(ctx.app, tokens[0], tableId, { type: "DEAL" });
      let h2 = await getTableState(ctx.app, tokens[0], tableId);
      let guard = 0;
      while (h2.street !== "SHOWDOWN" && guard < 20) {
        await executeAction(ctx.app, tokens[h2.actionTo], tableId, { type: "FOLD" });
        h2 = await getTableState(ctx.app, tokens[0], tableId);
        guard += 1;
      }
      expect(h2.handId).not.toBe(showdown.handId);
      expect(h2.street).toBe("SHOWDOWN");

      await runIntent(intent);
      const after = await getTableState(ctx.app, tokens[0], tableId);
      expect(after.handId).toBe(h2.handId);
      expect(after.street).toBe("SHOWDOWN");
      expect(after.version).toBe(h2.version);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("D. duplicate deliveries of the same intent deal the next hand only once", async () => {
    const { tableId, tokens, showdown, intent } = await setupCompletedHand("next-hand-duplicate");
    try {
      await runIntent(intent);
      const first = await getTableState(ctx.app, tokens[0], tableId);
      expect(first.handNumber).toBe(showdown.handNumber + 1);

      await runIntent(intent);
      await runIntent(intent);
      const after = await getTableState(ctx.app, tokens[0], tableId);
      expect(after.handId).toBe(first.handId);
      expect(after.handNumber).toBe(first.handNumber);
      expect(after.version).toBe(first.version);
      expect(sumCurrentBets(after)).toBe(15);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("E. fewer than two active players parks the table in WAITING without dealing", async () => {
    const { tableId, tokens, showdown, intent } =
      await setupCompletedHand("next-hand-insufficient");
    try {
      const winnerToken = tokens[showdown.winners[0].seat];
      const loserSeat = 1 - showdown.winners[0].seat;
      await standFromTable(ctx.app, tokens[loserSeat], tableId);

      const before = await getTableState(ctx.app, winnerToken, tableId);
      expect(before.players.filter((p: any) => p && p.stack > 0)).toHaveLength(1);

      await runIntent(intent);
      const after = await getTableState(ctx.app, winnerToken, tableId);
      expect(after.handId).toBe(before.handId);
      expect(after.handNumber).toBe(before.handNumber);
      expect(after.version).toBe(before.version);
      const table = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
      expect(table.status).toBe("WAITING");
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("F. auto-deals the next hand normally from a completed showdown", async () => {
    const { tableId, tokens, showdown, intent } = await setupCompletedHand("next-hand-normal");
    try {
      await runIntent(intent);
      const after = await getTableState(ctx.app, tokens[0], tableId);
      expect(after.handId).not.toBe(showdown.handId);
      expect(after.street).toBe("PREFLOP");
      expect(after.handNumber).toBe(showdown.handNumber + 1);
      expect(after.version).toBe(showdown.version + 1);
      expect(sumCurrentBets(after)).toBe(15);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("legacy intents without an identity keep the strict version guard", async () => {
    const { tableId, tokens, showdown } = await setupCompletedHand("next-hand-legacy");
    try {
      // Benign same-hand version change after the hand completed.
      const winnerToken = tokens[showdown.winners[0].seat];
      await executeAction(ctx.app, winnerToken, tableId, { type: "SHOW" });
      const afterShow = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterShow.version).toBe(showdown.version + 1);

      // Stale legacy payload: strict version mismatch is a no-op, never guessed.
      await runIntent({ tableId, expectedVersion: showdown.version });
      const afterStale = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterStale.handId).toBe(showdown.handId);
      expect(afterStale.street).toBe("SHOWDOWN");
      expect(afterStale.version).toBe(afterShow.version);

      // Current-version legacy payload still advances exactly once.
      await runIntent({ tableId, expectedVersion: afterShow.version });
      const afterDeal = await getTableState(ctx.app, winnerToken, tableId);
      expect(afterDeal.handId).not.toBe(showdown.handId);
      expect(afterDeal.street).toBe("PREFLOP");
      expect(afterDeal.version).toBe(afterShow.version + 1);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("a matching hand without winners is never advanced", async () => {
    const { tableId, tokens, showdown, intent } = await setupCompletedHand("next-hand-no-winners");
    try {
      const table = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
      const snapshot = JSON.parse(table.state as string);
      snapshot.winners = null;
      await ctx.app.prisma.table.update({
        where: { id: tableId },
        data: { state: JSON.stringify(snapshot) },
      });

      await runIntent(intent);
      const after = await getTableState(ctx.app, tokens[0], tableId);
      expect(after.handId).toBe(showdown.handId);
      expect(after.handNumber).toBe(showdown.handNumber);
      const durable = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
      expect(durable.stateVersion).toBe(table.stateVersion);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("no-ops for a missing table and for a CLOSED table", async () => {
    await runIntent({
      tableId: "missing-next-hand-table",
      expectedVersion: 0,
      expectedHandId: "missing-next-hand-table_h1",
    });

    const { tableId, intent } = await setupCompletedHand("next-hand-closed");
    try {
      await ctx.app.prisma.table.update({ where: { id: tableId }, data: { status: "CLOSED" } });
      await runIntent(intent);
      const table = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
      expect(table.status).toBe("CLOSED");
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });
});
