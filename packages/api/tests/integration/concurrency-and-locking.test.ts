import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  getTableState,
  type TestContext,
} from "../helpers/test-utils.js";

describe("Stand endpoint lock namespace", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);
  });

  afterAll(async () => {
    if (ctx.tableId) {
      await ctx.app.prisma.handHistory.deleteMany({
        where: { tableId: ctx.tableId },
      });
      await ctx.app.prisma.table.delete({ where: { id: ctx.tableId } }).catch(() => {});
    }
    await runCleanup(ctx.cleanup);
  });

  it("uses the same Redis lock key as the processAction method", async () => {
    const [player1] = ctx.users;

    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "Lock Key Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, ctx.tableId, 1000, 0);

    const standLockKey = `lock:table:${ctx.tableId}`;
    const gameLockKey = `lock:table:${ctx.tableId}`;

    expect(standLockKey).toBe(gameLockKey);
  });

  it("serializes stand while the shared table lock is held", async () => {
    const [player1] = ctx.users;

    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "Stand Race Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, ctx.tableId, 1000, 0);

    const lock = await ctx.app.redlock.acquire([`lock:table:${ctx.tableId}`], 60000);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/tables/${ctx.tableId}/stand`,
        headers: { authorization: `Bearer ${player1.token}` },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await lock.release();
    }

    const stateAfter = await getTableState(ctx.app, player1.token, ctx.tableId);
    const player = stateAfter.players.find((p: any) => p?.id === player1.id);
    expect(player).not.toBeNull();
  });
});
