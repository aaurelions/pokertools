/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetTableStateResponseSchema } from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  type TestContext,
} from "../helpers/test-utils.js";

let ctx: TestContext;
let tableId: string;
beforeAll(async () => {
  ctx = await initTestContext(3, 10000);
  tableId = await createTable(ctx.app, ctx.users[0].token, {
    name: "Masked state contract",
    mode: "CASH",
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 2,
    timeBankSeconds: 90,
  });
  await buyIn(ctx.app, ctx.users[0].token, tableId, 1000, 0);
  await buyIn(ctx.app, ctx.users[1].token, tableId, 1000, 1);
});
afterAll(async () => {
  if (ctx) await runCleanup(ctx.cleanup);
});

describe("conditional table wire state", () => {
  it("uses the observation projection and preserves both seats' time banks", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/tables/${tableId}`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
    });
    expect(response.statusCode).toBe(200);
    const { state } = GetTableStateResponseSchema.parse(response.json());
    const observation = await ctx.app.gameManager.getObservation(tableId, ctx.users[0].id);
    expect(state).toEqual(observation.state);
    expect(state.timeBanks).toEqual({ "0": 90, "1": 90 });
    expect(state).not.toHaveProperty("previousStates");
  });
  it("normalizes spectators and retains conditional 304 responses", async () => {
    const headers = { authorization: `Bearer ${ctx.users[2].token}` };
    const response = await ctx.app.inject({ method: "GET", url: `/tables/${tableId}`, headers });
    expect(response.statusCode).toBe(200);
    const { state } = GetTableStateResponseSchema.parse(response.json());
    expect(state.viewingPlayerId).toBeNull();
    expect(
      state.players
        .filter((player) => player !== null)
        .every((player) => (player.hand ?? []).length === 0)
    ).toBe(true);
    const unchanged = await ctx.app.inject({
      method: "GET",
      url: `/tables/${tableId}?since=${state.version}`,
      headers,
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
  });
});
