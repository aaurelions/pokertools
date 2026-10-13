/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionType } from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await initTestContext(3, 10000);
});
afterAll(async () => {
  if (ctx) await runCleanup(ctx.cleanup);
});

const post = (token: string, tableId: string) =>
  ctx.app.inject({
    method: "POST",
    url: `/tables/${tableId}/sit-in`,
    headers: { authorization: `Bearer ${token}` },
  });

describe("POST /tables/:id/sit-in", () => {
  it("clears a timeout sit-out, publishes state and rejects invalid callers", async () => {
    const [a, b, outsider] = ctx.users;
    const tableId = await createTable(ctx.app, a.token, {
      name: "Sit-in",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    try {
      await buyIn(ctx.app, a.token, tableId, 500, 0);
      await buyIn(ctx.app, b.token, tableId, 500, 1);
      await executeAction(ctx.app, a.token, tableId, { type: "DEAL" });
      const state = await ctx.app.gameManager.getState(tableId, a.id);
      const timedOut = state.players[state.actionTo!]!;
      await ctx.app.gameManager.processAction(
        tableId,
        { type: ActionType.TIMEOUT, playerId: timedOut.id },
        timedOut.id,
        { expectedVersion: state.version }
      );
      const out = await ctx.app.gameManager.getState(tableId, a.id);
      expect(out.players.find((p) => p?.id === timedOut.id)!.isSittingOut).toBe(true);

      const token = timedOut.id === a.id ? a.token : b.token;
      const other = timedOut.id === a.id ? b.token : a.token;

      // Not sitting out -> rejected; not seated -> rejected; unauthenticated -> 401.
      expect((await post(other, tableId)).statusCode).toBe(400);
      expect((await post(outsider.token, tableId)).statusCode).toBe(400);
      const anon = await ctx.app.inject({ method: "POST", url: `/tables/${tableId}/sit-in` });
      expect(anon.statusCode).toBe(401);

      const eventsBefore = await ctx.app.prisma.gameEvent.count({ where: { tableId } });
      const res = await post(token, tableId);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });

      const after = await ctx.app.gameManager.getState(tableId, a.id);
      expect(after.players.find((p) => p?.id === timedOut.id)!.isSittingOut).toBe(false);
      expect(after.version).toBe(out.version + 1);
      expect(await ctx.app.prisma.gameEvent.count({ where: { tableId } })).toBeGreaterThan(
        eventsBefore
      );

      // A second call is no longer legal.
      expect((await post(token, tableId)).statusCode).toBe(400);
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  });
});
