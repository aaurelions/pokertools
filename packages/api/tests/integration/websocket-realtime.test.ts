/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import type { ObservationMessage } from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  getTableState,
  cleanupTestTable,
  waitFor,
  type TestContext,
} from "../helpers/test-utils.js";

const isObservation = (msg: any): msg is ObservationMessage =>
  msg?.type === "OBSERVATION" && typeof msg.tableId === "string" && Boolean(msg.observation);

const observations = (messages: any[]): ObservationMessage[] =>
  messages.filter(isObservation) as ObservationMessage[];

describe("WebSocket - Real-time Updates Integration Test", () => {
  let ctx: TestContext;
  let wsUrl: string;

  beforeAll(async () => {
    ctx = await initTestContext(3, 10000);

    // Start the server and get the port
    await ctx.app.listen({ port: 0, host: "127.0.0.1" }); // Use port 0 to get random available port
    const address = ctx.app.server.address();
    const port = typeof address === "object" && address ? address.port : 3000;
    wsUrl = `ws://127.0.0.1:${port}/ws/play`;
  });

  afterAll(async () => {
    if (ctx.tableId) {
      await cleanupTestTable(ctx.app, ctx.tableId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("denies unseated private-table joins and missing tables, then authorizes a seated member", async () => {
    const [owner, viewer] = ctx.users;
    const tableId = await createTable(ctx.app, owner.token, {
      name: "Private membership gate",
      mode: "CASH",
      smallBlind: 1,
      bigBlind: 2,
    });
    const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${viewer.token}`]);
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    try {
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ type: "JOIN", tableId, requestId: "denied-member" }));
      await waitFor(() => messages.some((message) => message.code === "JOIN_NOT_AUTHORIZED"), 5000);
      expect(observations(messages)).toHaveLength(0);
      expect(messages.find((message) => message.code === "JOIN_NOT_AUTHORIZED").requestId).toBe(
        "denied-member"
      );
      ws.send(JSON.stringify({ type: "JOIN", tableId: "missing-table", requestId: "missing" }));
      await waitFor(() => messages.some((message) => message.code === "TABLE_NOT_FOUND"), 5000);
      await buyIn(ctx.app, viewer.token, tableId, 100, 0);
      ws.send(JSON.stringify({ type: "JOIN", tableId, requestId: "seated-member" }));
      await waitFor(() => observations(messages).length > 0, 5000);
      expect(observations(messages)[0].observation.state.viewingPlayerId).toBe(viewer.id);
    } finally {
      ws.close();
      await cleanupTestTable(ctx.app, tableId);
    }
  });

  it("should receive full canonical observations via WebSocket", async () => {
    const [player1, player2, player3] = ctx.users;

    // =========================================================================
    // STEP 1: Create Table
    // =========================================================================
    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "WebSocket Test",
      allowSpectators: true,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    // =========================================================================
    // STEP 2: Connect WebSocket Clients
    // =========================================================================
    const player1Messages: any[] = [];
    const player2Messages: any[] = [];

    const ws1 = new WebSocket(wsUrl, ["pokertools", `jwt.${player1.token}`]);
    const ws2 = new WebSocket(wsUrl, ["pokertools", `jwt.${player2.token}`]);

    ws1.on("message", (data) => player1Messages.push(JSON.parse(data.toString())));
    ws2.on("message", (data) => player2Messages.push(JSON.parse(data.toString())));

    // Wait for connections to open
    await Promise.all([
      new Promise((resolve) => ws1.once("open", resolve)),
      new Promise((resolve) => ws2.once("open", resolve)),
    ]);

    // =========================================================================
    // STEP 3: Subscribe to Table
    // =========================================================================
    ws1.send(JSON.stringify({ type: "JOIN", tableId: ctx.tableId }));
    ws2.send(JSON.stringify({ type: "JOIN", tableId: ctx.tableId }));

    await waitFor(
      () => observations(player1Messages).length > 0 && observations(player2Messages).length > 0,
      7000
    );

    const firstP1 = observations(player1Messages)[0]!;
    expect(firstP1.type).toBe("OBSERVATION");
    expect(firstP1.tableId).toBe(ctx.tableId);
    expect(firstP1.timestamp).toBeTypeOf("number");
    // The observation is principal-scoped and carries the full masked projection.
    // Before seating, the viewer is a spectator (null); never another principal.
    expect([null, player1.id]).toContain(firstP1.observation.state.viewingPlayerId);
    expect(firstP1.observation.state.deck).toEqual([]);
    // No non-viewer seat ever exposes hole cards, even before seating.
    for (const player of firstP1.observation.state.players) {
      if (!player || player.id === player1.id) continue;
      expect(player.hand).toBeNull();
    }

    // No legacy notification-only frames may appear on the wire.
    for (const message of player1Messages) {
      expect(["OBSERVATION", "ACK"]).toContain(message.type);
    }

    // =========================================================================
    // STEP 4: Players Buy In (Should Trigger Full Observations)
    // =========================================================================
    const updateCountBefore = player1Messages.length;
    await buyIn(ctx.app, player1.token, ctx.tableId, 1000, 0);

    await waitFor(() => player1Messages.length > updateCountBefore, 7000);

    const afterBuyIn = observations(player1Messages).at(-1)!;
    expect(afterBuyIn.observation.state.players.find((p) => p?.id === player1.id)?.stack).toBe(
      1000
    );
    // Once seated, the observation is scoped to the authenticated principal.
    expect(afterBuyIn.observation.state.viewingPlayerId).toBe(player1.id);
    expect(afterBuyIn.observation.version).toBeGreaterThanOrEqual(firstP1.observation.version);

    console.log(`✅ Full OBSERVATION projection received and masked`);

    // =========================================================================
    // STEP 5: More Players Join and Deal
    // =========================================================================
    await buyIn(ctx.app, player2.token, ctx.tableId, 1000, 1);
    await buyIn(ctx.app, player3.token, ctx.tableId, 1000, 2);

    await executeAction(ctx.app, player1.token, ctx.tableId, { type: "DEAL" });

    await waitFor(
      () => observations(player1Messages).at(-1)?.observation.state.street === "PREFLOP",
      3000
    );

    const dealObservation = observations(player1Messages).at(-1)!;
    expect(dealObservation.observation.state.street).toBe("PREFLOP");
    expect(dealObservation.observation.state.viewingPlayerId).toBe(player1.id);
    // Hidden information: the viewer sees only their own hole cards.
    expect(
      dealObservation.observation.state.players.find((p) => p?.id === player2.id)?.hand
    ).toBeNull();

    console.log(`✅ Deal observation received with masked hidden information`);

    // =========================================================================
    // STEP 6: Execute Action and Verify Broadcast
    // =========================================================================
    const actingSeat = dealObservation.observation.state.actionTo;
    expect(actingSeat).not.toBeNull();
    const actingPlayer = ctx.users[actingSeat!]!;

    const p1BeforeAction = observations(player1Messages).length;
    const p2BeforeAction = observations(player2Messages).length;

    await executeAction(ctx.app, actingPlayer.token, ctx.tableId, { type: "FOLD" });

    await waitFor(() => observations(player1Messages).length > p1BeforeAction, 3000);
    await waitFor(() => observations(player2Messages).length > p2BeforeAction, 3000);

    expect(observations(player1Messages).at(-1)!.observation.version).toBeGreaterThan(
      dealObservation.observation.version
    );

    console.log(`✅ Full observation broadcast to all subscribers`);

    // =========================================================================
    // STEP 7: Unsubscribe from Table
    // =========================================================================
    ws1.send(JSON.stringify({ type: "LEAVE", tableId: ctx.tableId }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const p1AfterLeave = player1Messages.length;
    const p2AfterLeave = player2Messages.length;

    // Player 2 still subscribed, execute another action if a turn remains.
    const currentState = await getTableState(ctx.app, player1.token, ctx.tableId);

    if (
      currentState.actionTo !== null &&
      currentState.actionTo !== undefined &&
      currentState.street !== "SHOWDOWN"
    ) {
      const nextPlayer = ctx.users[currentState.actionTo];
      if (nextPlayer) {
        await executeAction(ctx.app, nextPlayer.token, ctx.tableId, { type: "FOLD" });

        await waitFor(() => player2Messages.length > p2AfterLeave, 3000);

        // Player 1 should NOT receive updates (unsubscribed)
        expect(player1Messages.length).toBe(p1AfterLeave);
        // Player 2 should receive updates (still subscribed)
        expect(player2Messages.length).toBeGreaterThan(p2AfterLeave);

        console.log(`✅ Unsubscribe verified - no updates to unsubscribed client`);
      }
    }

    // =========================================================================
    // STEP 8: Close Connections
    // =========================================================================
    ws1.close();
    ws2.close();

    await Promise.all([
      new Promise((resolve) => ws1.once("close", resolve)),
      new Promise((resolve) => ws2.once("close", resolve)),
    ]);

    console.log(`✅ WebSocket connections closed`);
  }, 20000);

  it("should handle connection errors gracefully", async () => {
    // Try to connect with invalid token in subprotocol
    const ws = new WebSocket(wsUrl, ["pokertools", "jwt.invalid-token"]);

    // WebSocket should close with auth error
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => {
        resolve(code);
      });
    });

    expect(closeCode).toBe(4001); // Unauthorized
    console.log(`✅ Invalid token handled with close code: ${closeCode}`);
  });

  it("should support multiple simultaneous table subscriptions", async () => {
    const [player1] = ctx.users;

    // Create two tables
    const table1 = await createTable(ctx.app, player1.token, {
      name: "Multi-Table Test 1",
      allowSpectators: true,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    const table2 = await createTable(ctx.app, player1.token, {
      name: "Multi-Table Test 2",
      allowSpectators: true,
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
    });

    const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${player1.token}`]);

    // Set up message handler BEFORE waiting for open to avoid race conditions
    const updates: any[] = [];
    ws.on("message", (data) => {
      updates.push(JSON.parse(data.toString()));
    });

    await new Promise((resolve) => ws.once("open", resolve));

    // Small delay to ensure message handler is fully registered
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Subscribe to both tables sequentially to ensure proper ordering
    ws.send(JSON.stringify({ type: "JOIN", tableId: table1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({ type: "JOIN", tableId: table2 }));

    // Wait for observations from both tables
    await waitFor(() => {
      const table1Updates = observations(updates).filter((u) => u.tableId === table1);
      const table2Updates = observations(updates).filter((u) => u.tableId === table2);
      return table1Updates.length > 0 && table2Updates.length > 0;
    }, 5000);

    console.log(`✅ Received initial observations from both tables`);

    // Trigger updates on both tables to verify broadcasts
    const updatesBefore = observations(updates).length;
    await buyIn(ctx.app, player1.token, table1, 500, 0);
    await buyIn(ctx.app, player1.token, table2, 500, 1);

    await waitFor(() => observations(updates).length > updatesBefore, 5000);

    const table1Updates = observations(updates).filter((u) => u.tableId === table1);
    const table2Updates = observations(updates).filter((u) => u.tableId === table2);

    expect(table1Updates.length).toBeGreaterThan(0);
    expect(table2Updates.length).toBeGreaterThan(0);
    // After buy-in, observations for both tables are scoped to the principal.
    expect(table1Updates.at(-1)!.observation.state.viewingPlayerId).toBe(player1.id);
    expect(table2Updates.at(-1)!.observation.state.viewingPlayerId).toBe(player1.id);

    console.log(
      `✅ Received observations from both tables: Table1=${table1Updates.length}, Table2=${table2Updates.length}`
    );

    ws.close();

    // Cleanup
    await cleanupTestTable(ctx.app, table1);
    await cleanupTestTable(ctx.app, table2);
  }, 15000);

  it("OBSERVATION frames carry a full masked projection (no partial/version-only frames)", async () => {
    const [player1, player2] = ctx.users;

    const testTableId = await createTable(ctx.app, player1.token, {
      name: "Full Projection Protocol Test",
      allowSpectators: true,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    try {
      const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${player1.token}`]);
      await new Promise((resolve) => ws.once("open", resolve));

      const allMessages: any[] = [];
      ws.on("message", (data) => {
        allMessages.push(JSON.parse(data.toString()));
      });

      ws.send(JSON.stringify({ type: "JOIN", tableId: testTableId }));
      await waitFor(() => observations(allMessages).length > 0, 7000);

      const first = observations(allMessages)[0]!;
      expect(first.observation.turnId).toBeTypeOf("string");
      expect(first.observation.version).toBeTypeOf("number");
      expect(first.observation.eventSeq).toBeTypeOf("number");
      expect(Array.isArray(first.observation.legalActions)).toBe(true);
      expect([null, player1.id]).toContain(first.observation.state.viewingPlayerId);
      expect(first.observation.state.deck).toEqual([]);

      // Buy in both players to trigger a broadcast.
      await buyIn(ctx.app, player1.token, testTableId, 500, 0);
      await buyIn(ctx.app, player2.token, testTableId, 500, 1);

      await waitFor(() => observations(allMessages).length > 1, 7000);

      // Every frame is a full OBSERVATION; no STATE_UPDATE/SNAPSHOT partial frame.
      expect(allMessages.every((m) => m.type === "OBSERVATION" || m.type === "ACK")).toBe(true);

      // After buy-in, the latest projection is scoped to the principal.
      expect(observations(allMessages).at(-1)!.observation.state.viewingPlayerId).toBe(player1.id);

      for (const observation of observations(allMessages)) {
        expect(observation.type).toBe("OBSERVATION");
        expect(observation.tableId).toBeTypeOf("string");
        expect(observation.observation.state).toBeDefined();
        expect([null, player1.id]).toContain(observation.observation.state.viewingPlayerId);
        expect(observation.observation.state.deck).toEqual([]);
        // No other player's hole cards are ever present in the viewer's projection.
        for (const player of observation.observation.state.players) {
          if (!player || player.id === player1.id) continue;
          expect(player.hand).toBeNull();
        }
        expect(observation.timestamp).toBeTypeOf("number");
      }

      ws.close();
    } finally {
      await cleanupTestTable(ctx.app, testTableId);
    }
  }, 15000);
});
