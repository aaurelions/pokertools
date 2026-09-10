/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ActionType } from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  type TestContext,
} from "../helpers/test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await initTestContext(2, 10000);
});
afterAll(async () => {
  if (ctx) await runCleanup(ctx.cleanup);
});

it("scheduled timeouts settle a completed hand and stale jobs have no side effects", async () => {
  const [a, b] = ctx.users;
  const tableId = await createTable(ctx.app, a.token, {
    name: "Scheduled action regression",
    mode: "CASH",
    smallBlind: 5,
    bigBlind: 10,
  });
  await buyIn(ctx.app, a.token, tableId, 500, 0);
  await buyIn(ctx.app, b.token, tableId, 500, 1);
  await executeAction(ctx.app, a.token, tableId, { type: "DEAL" });
  const state = await ctx.app.gameManager.getState(tableId, a.id);
  const player = state.players[state.actionTo!]!;
  const settlement = vi.spyOn(ctx.app.jobQueues["settle-hand"], "add");
  const persistence = vi.spyOn(ctx.app.jobQueues["persist-snapshot"], "add");
  try {
    const stale = await ctx.app.gameManager.processAction(
      tableId,
      { type: ActionType.TIMEOUT, playerId: player.id },
      player.id,
      { expectedVersion: state.version - 1 }
    );
    expect(stale.version).toBe(state.version);
    expect(persistence).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();

    const completed = await ctx.app.gameManager.processAction(
      tableId,
      { type: ActionType.TIMEOUT, playerId: player.id },
      player.id,
      { expectedVersion: state.version }
    );
    expect(completed.winners).not.toBeNull();
    expect(completed.version).toBe(state.version + 1);
    expect(settlement).toHaveBeenCalledTimes(1);
    const payload = settlement.mock.calls[0][1] as {
      playerNetChanges: Record<string, string>;
      rakeTotal: string;
      handId: string;
    };
    expect(
      Object.values(payload.playerNetChanges).reduce(
        (sum, change) => sum + BigInt(change),
        BigInt(payload.rakeTotal)
      )
    ).toBe(0n);
    expect(Object.values(payload.playerNetChanges).sort()).toEqual(["-5", "5"]);
    expect(payload.handId).toBe(`${tableId}_${completed.handId}`);
    expect(persistence).toHaveBeenCalledTimes(1);
    const durable = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(JSON.parse(durable.state as string)._version).toBe(completed.version);
    await ctx.app.gameManager.processAction(
      tableId,
      { type: ActionType.SHOW, playerId: b.id },
      b.id
    );
    expect(settlement).toHaveBeenCalledTimes(1);
  } finally {
    settlement.mockRestore();
    persistence.mockRestore();
  }
});
