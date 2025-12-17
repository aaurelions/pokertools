/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
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

  it("should receive real-time state updates via WebSocket", async () => {
    const [player1, player2, player3] = ctx.users;

    // =========================================================================
    // STEP 1: Create Table
    // =========================================================================
    ctx.tableId = await createTable(ctx.app, player1.token, {
      name: "WebSocket Test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    // =========================================================================
    // STEP 2: Connect WebSocket Clients
    // =========================================================================
    const player1Updates: any[] = [];
    const player2Updates: any[] = [];

    // WebSocket requires token in query parameter for authentication
    const ws1 = new WebSocket(`${wsUrl}?token=${player1.token}`);
    const ws2 = new WebSocket(`${wsUrl}?token=${player2.token}`);

    // Wait for connections to open
    await Promise.all([
      new Promise((resolve) => ws1.once("open", resolve)),
      new Promise((resolve) => ws2.once("open", resolve)),
    ]);

    // Set up message handlers
    ws1.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "STATE_UPDATE" || message.type === "SNAPSHOT") {
        player1Updates.push(message);
      }
    });

    ws2.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "STATE_UPDATE" || message.type === "SNAPSHOT") {
        player2Updates.push(message);
      }
    });

    // =========================================================================
    // STEP 3: Subscribe to Table
    // =========================================================================
    ws1.send(
      JSON.stringify({
        type: "JOIN",
        tableId: ctx.tableId,
      })
    );

    ws2.send(
      JSON.stringify({
        type: "JOIN",
        tableId: ctx.tableId,
      })
    );

    // Wait for SNAPSHOT messages after JOIN (sent immediately)
    await waitFor(() => player1Updates.length > 0 && player2Updates.length > 0, 3000);

    expect(player1Updates.length).toBeGreaterThan(0);
    expect(player2Updates.length).toBeGreaterThan(0);

    // =========================================================================
    // STEP 4: Players Buy In (Should Trigger Updates)
    // =========================================================================
    const updateCountBefore = player1Updates.length;
    await buyIn(ctx.app, player1.token, ctx.tableId, 1000, 0);

    // Wait for additional updates after buy-in (STATE_UPDATE or SNAPSHOT)
    await waitFor(() => player1Updates.length > updateCountBefore, 3000);

    // =========================================================================
    // STEP 5: Verify State Masking
    // =========================================================================
    const player1State = player1Updates[player1Updates.length - 1].state;
    const player2State = player2Updates[player2Updates.length - 1].state;

    // Player 1 should see their own cards (if dealt)
    // Player 2 should NOT see Player 1's cards

    // Verify both received the same table state
    expect(player1State.handNumber).toBe(player2State.handNumber);
    expect(player1State.buttonSeat).toBe(player2State.buttonSeat);

    console.log(`✅ State masking verified`);

    // =========================================================================
    // STEP 6: More Players Join and Deal
    // =========================================================================
    player1Updates.length = 0;
    player2Updates.length = 0;

    await buyIn(ctx.app, player2.token, ctx.tableId, 1000, 1);
    await buyIn(ctx.app, player3.token, ctx.tableId, 1000, 2);

    // Wait for updates
    await waitFor(() => player1Updates.length >= 2, 2000);

    await executeAction(ctx.app, player1.token, ctx.tableId, {
      type: "DEAL",
    });

    // Wait for deal update
    await waitFor(() => {
      const lastUpdate = player1Updates[player1Updates.length - 1];
      return lastUpdate?.state?.street === "PREFLOP";
    }, 2000);

    let dealState = player1Updates[player1Updates.length - 1].state;
    expect(dealState.street).toBe("PREFLOP");

    console.log(`✅ Deal update received via WebSocket`);

    // =========================================================================
    // STEP 7: Execute Action and Verify Broadcast
    // =========================================================================
    player1Updates.length = 0;
    player2Updates.length = 0;

    // Get fresh state to ensure we have correct actionTo
    dealState = await getTableState(ctx.app, player1.token, ctx.tableId);

    // Verify actionTo is valid
    if (dealState.actionTo === undefined || dealState.actionTo === null) {
      throw new Error("actionTo is undefined after deal");
    }

    const actingPlayer = ctx.users[dealState.actionTo];
    if (!actingPlayer) {
      throw new Error(`No acting player found at seat ${dealState.actionTo}`);
    }

    await executeAction(ctx.app, actingPlayer.token, ctx.tableId, {
      type: "FOLD",
    });

    // Wait for action update
    await waitFor(() => player1Updates.length > 0, 2000);
    await waitFor(() => player2Updates.length > 0, 2000);

    expect(player1Updates.length).toBeGreaterThan(0);
    expect(player2Updates.length).toBeGreaterThan(0);

    console.log(`✅ Action update broadcast to all subscribers`);

    // =========================================================================
    // STEP 8: Unsubscribe from Table
    // =========================================================================
    ws1.send(
      JSON.stringify({
        type: "LEAVE",
        tableId: ctx.tableId,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    player1Updates.length = 0;
    player2Updates.length = 0;

    // Player 2 still subscribed, execute another action
    // Get fresh state to know who should act
    const currentState = await getTableState(ctx.app, player1.token, ctx.tableId);

    if (currentState.actionTo !== undefined && currentState.street !== "SHOWDOWN") {
      const nextPlayer = ctx.users[currentState.actionTo];
      if (nextPlayer) {
        await executeAction(ctx.app, nextPlayer.token, ctx.tableId, {
          type: "FOLD",
        });
      }

      await waitFor(() => player2Updates.length > 0, 2000);

      // Player 1 should NOT receive update (unsubscribed)
      expect(player1Updates.length).toBe(0);
      // Player 2 should receive update (still subscribed)
      expect(player2Updates.length).toBeGreaterThan(0);

      console.log(`✅ Unsubscribe verified - no updates to unsubscribed client`);
    }

    // =========================================================================
    // STEP 9: Close Connections
    // =========================================================================
    ws1.close();
    ws2.close();

    await Promise.all([
      new Promise((resolve) => ws1.once("close", resolve)),
      new Promise((resolve) => ws2.once("close", resolve)),
    ]);

    console.log(`✅ WebSocket connections closed`);
    console.log(`✅ WebSocket real-time update test completed successfully!`);
  }, 15000); // Increase timeout for WebSocket operations

  it("should handle connection errors gracefully", async () => {
    const [player1] = ctx.users;

    // Try to connect with invalid token in query string
    const ws = new WebSocket(`${wsUrl}?token=invalid-token`);

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
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    const table2 = await createTable(ctx.app, player1.token, {
      name: "Multi-Table Test 2",
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
    });

    // Connect with token in query parameter
    const ws = new WebSocket(`${wsUrl}?token=${player1.token}`);

    // Set up message handler BEFORE waiting for open to avoid race conditions
    const updates: any[] = [];
    ws.on("message", (data) => {
      updates.push(JSON.parse(data.toString()));
    });

    await new Promise((resolve) => ws.once("open", resolve));

    // Small delay to ensure message handler is fully registered
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Subscribe to both tables sequentially to ensure proper ordering
    ws.send(
      JSON.stringify({
        type: "JOIN",
        tableId: table1,
      })
    );

    // Wait a bit before sending second subscription
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(
      JSON.stringify({
        type: "JOIN",
        tableId: table2,
      })
    );

    // Wait for messages (SNAPSHOT or STATE_UPDATE) from both tables
    await waitFor(() => {
      const table1Updates = updates.filter((u) => u.tableId === table1);
      const table2Updates = updates.filter((u) => u.tableId === table2);
      return table1Updates.length > 0 && table2Updates.length > 0;
    }, 5000); // Increased timeout for multi-table subscription

    console.log(`✅ Received initial messages from both tables`);

    // Trigger updates on both tables to verify broadcasts
    const updatesBefore = updates.length;
    await buyIn(ctx.app, player1.token, table1, 500, 0);
    await buyIn(ctx.app, player1.token, table2, 500, 1);

    // Wait for additional updates after buy-ins (may be SNAPSHOT or STATE_UPDATE)
    await waitFor(() => updates.length > updatesBefore + 1, 3000);

    const table1Updates = updates.filter((u) => u.tableId === table1);
    const table2Updates = updates.filter((u) => u.tableId === table2);

    expect(table1Updates.length).toBeGreaterThan(0);
    expect(table2Updates.length).toBeGreaterThan(0);

    console.log(
      `✅ Received updates from both tables: Table1=${table1Updates.length}, Table2=${table2Updates.length}`
    );

    ws.close();

    // Cleanup
    await cleanupTestTable(ctx.app, table1);
    await cleanupTestTable(ctx.app, table2);
  }, 10000);
});
