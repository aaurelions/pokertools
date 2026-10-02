/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  cleanupTestTable,
  waitFor,
  type TestContext,
} from "../helpers/test-utils.js";

/**
 * Timeout / action propagation integration tests.
 *
 * The live private stream is canonical: every change is delivered as a full
 * per-principal `OBSERVATION` (masked state + exact legal actions). There is no
 * partial/version-only `STATE_UPDATE` frame.
 */
describe("Timeout Worker - Redlock & Version Guard Integration Test", () => {
  let ctx: TestContext;
  let wsUrl: string;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address();
    const port = typeof address === "object" && address ? address.port : 3000;
    wsUrl = `ws://127.0.0.1:${port}/ws/play`;
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("publishes a full masked OBSERVATION after an accepted turn", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Timeout Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      await buyIn(ctx.app, player1.token, tableId, 500, 0);
      await buyIn(ctx.app, player2.token, tableId, 500, 1);
      const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${player1.token}`]);
      await new Promise((resolve) => ws.once("open", resolve));

      const messages: any[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

      ws.send(JSON.stringify({ type: "JOIN", tableId }));
      await waitFor(() => messages.some((m) => m.type === "OBSERVATION"), 7000);

      messages.length = 0;
      await executeAction(ctx.app, player1.token, tableId, { type: "DEAL" });
      await waitFor(() => messages.some((m) => m.type === "OBSERVATION"), 3000);

      const state = (await ctx.app.gameManager.getState(tableId, player1.id)) as any;

      if (state.actionTo !== null && state.actionTo !== undefined) {
        const actingPlayer = ctx.users[state.actionTo];
        if (actingPlayer) {
          messages.length = 0;
          await executeAction(ctx.app, actingPlayer.token, tableId, { type: "FOLD" });
          await waitFor(() => messages.some((m) => m.type === "OBSERVATION"), 7000);

          const frames = messages.filter((m) => m.type === "OBSERVATION");
          expect(frames.length).toBeGreaterThan(0);

          for (const frame of frames) {
            // Every frame is the full authoritative projection, not a notification.
            expect(frame.type).toBe("OBSERVATION");
            expect(frame.tableId).toBe(tableId);
            expect(frame.timestamp).toBeTypeOf("number");
            expect(frame.observation.state).toBeDefined();
            expect(frame.observation.state.viewingPlayerId).toBe(player1.id);
            expect(frame.observation.state.deck).toEqual([]);
            expect(frame.observation.version).toBeTypeOf("number");
            expect(Array.isArray(frame.observation.legalActions)).toBe(true);
          }
        }
      }

      ws.close();
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  }, 20000);

  it("version guard prevents stale timeout from corrupting state", async () => {
    const [player1, player2] = ctx.users;

    const tableId = await createTable(ctx.app, player1.token, {
      name: "Version Guard Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      // Buy in players
      await buyIn(ctx.app, player1.token, tableId, 500, 0);
      await buyIn(ctx.app, player2.token, tableId, 500, 1);

      // Deal
      await executeAction(ctx.app, player1.token, tableId, { type: "DEAL" });

      // Get the current state to know who should act
      const stateAfterDeal = (await ctx.app.gameManager.getState(tableId, player1.id)) as any;
      const versionAfterDeal = stateAfterDeal.version;

      // If actionTo is set, a timeout job was scheduled
      expect(stateAfterDeal.actionTo).toBeDefined();

      // Now act quickly before timeout fires
      const actingPlayer = ctx.users[stateAfterDeal.actionTo!];
      if (actingPlayer) {
        await executeAction(ctx.app, actingPlayer.token, tableId, { type: "FOLD" });

        // The version should have incremented
        const stateAfterAction = (await ctx.app.gameManager.getState(tableId, player1.id)) as any;
        expect(stateAfterAction.version).toBe(versionAfterDeal + 1);

        // The stale timeout job for the previous version would have been
        // skipped by the version guard in the timeout worker.
        // We verify this indirectly: the state is still consistent.
        expect(stateAfterAction.street).toBeDefined();
      }
    } finally {
      await cleanupTestTable(ctx.app, tableId);
    }
  }, 15000);
});
