/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  initTestContext,
  runCleanup,
  getTableState,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";
import { scanAndAdvanceTournamentBlinds } from "../../src/workers/tournament-blinds.js";

const TEST_BLIND_INTERVAL_MS = 5000; // 5 seconds for tests

/**
 * Helper to create and start a simple two-player tournament via the API.
 * Registers all participants (including creator) and starts the tournament.
 */
async function createAndStartTournament(
  ctx: TestContext,
  creator: { token: string },
  additionalPlayers: Array<{ token: string }>,
  overrides: { name?: string } = {}
): Promise<{ tournamentId: string; tableId: string }> {
  const createResponse = await ctx.app.inject({
    method: "POST",
    url: "/tournaments",
    headers: { authorization: `Bearer ${creator.token}` },
    payload: {
      name: overrides.name ?? "Blinds Test Tournament",
      buyIn: 500,
      fee: 0,
      startingStack: 1500,
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 6,
      payoutPercentages: [100],
    },
  });
  expect(createResponse.statusCode).toBe(200);
  const { tournamentId, tableId } = JSON.parse(createResponse.body);

  // Register all participants: creator + additional players
  const allPlayers = [creator, ...additionalPlayers];
  for (let i = 0; i < allPlayers.length; i++) {
    const registerResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/register`,
      headers: { authorization: `Bearer ${allPlayers[i].token}` },
      payload: { seat: i, idempotencyKey: crypto.randomUUID() },
    });
    expect(registerResponse.statusCode).toBe(200);
  }

  const startResponse = await ctx.app.inject({
    method: "POST",
    url: `/tournaments/${tournamentId}/start`,
    headers: { authorization: `Bearer ${creator.token}` },
  });
  expect(startResponse.statusCode).toBe(200);

  return { tournamentId, tableId };
}

function silentLogger() {
  return {
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  };
}

describe("Tournament Blinds - Automatic Blind Progression", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(4, 20000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  // ---------------------------------------------------------------------------
  // Manual advance-blinds endpoint
  // ---------------------------------------------------------------------------

  it("should set lastBlindAdvancedAt when tournament starts", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "Start Sets LastAdvance",
    });

    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });

    expect(tournament.startedAt).toBeTruthy();
    expect(tournament.lastBlindAdvancedAt).toBeTruthy();
    expect(tournament.lastBlindAdvancedAt!.getTime()).toBe(tournament.startedAt!.getTime());

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should update lastBlindAdvancedAt when manual advance-blinds succeeds", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "Manual Advance Updates",
    });

    const before = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });
    const originalAdvanceAt = before.lastBlindAdvancedAt!.getTime();

    // Small delay so timestamp changes
    await new Promise((r) => setTimeout(r, 100));

    const advResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/advance-blinds`,
      headers: { authorization: `Bearer ${player1.token}` },
    });
    expect(advResponse.statusCode).toBe(200);

    const after = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });
    expect(after.lastBlindAdvancedAt).toBeTruthy();
    expect(after.lastBlindAdvancedAt!.getTime()).toBeGreaterThan(originalAdvanceAt);

    const state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.blindLevel).toBe(1);
    expect(state.smallBlind).toBeGreaterThan(25);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should return error for non-running tournament manual advance", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "Non-Running Manual",
    });

    const settleResponse = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/settle`,
      headers: { authorization: `Bearer ${player1.token}` },
    });
    // Settlement may or may not succeed depending on game state; if it does,
    // the tournament is now FINISHED.
    if (settleResponse.statusCode === 200) {
      const advResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/advance-blinds`,
        headers: { authorization: `Bearer ${player1.token}` },
      });
      expect(advResponse.statusCode).toBe(400);

      const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
        where: { id: tournamentId },
      });
      expect(tournament.lastBlindAdvancedAt!.getTime()).toBe(tournament.startedAt!.getTime());
    }

    await cleanupTestTable(ctx.app, tableId);
  });

  // ---------------------------------------------------------------------------
  // Automatic scheduler (scanAndAdvanceTournamentBlinds)
  // ---------------------------------------------------------------------------

  it("should advance blinds on eligible tournament via scheduler", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "Eligible Scheduler",
    });

    let state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.blindLevel).toBe(0);

    // Backdate lastBlindAdvancedAt to make it eligible
    const pastTime = new Date(Date.now() - 10000);
    await ctx.app.prisma.tournament.update({
      where: { id: tournamentId },
      data: { lastBlindAdvancedAt: pastTime },
    });

    const result = await scanAndAdvanceTournamentBlinds(
      ctx.app.prisma,
      ctx.app.redis,
      silentLogger(),
      TEST_BLIND_INTERVAL_MS
    );

    expect(result.advanced).toContain(tournamentId);
    expect(result.skipped).not.toContain(tournamentId);

    const updated = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });
    expect(updated.lastBlindAdvancedAt!.getTime()).toBeGreaterThan(pastTime.getTime());

    state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.blindLevel).toBe(1);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should skip too-recent tournament (lastBlindAdvancedAt within interval)", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "Skip Recent Tournament",
    });

    let state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.blindLevel).toBe(0);

    // lastBlindAdvancedAt was just set to startedAt — it's within the interval
    const result = await scanAndAdvanceTournamentBlinds(
      ctx.app.prisma,
      ctx.app.redis,
      silentLogger(),
      TEST_BLIND_INTERVAL_MS
    );

    expect(result.skipped).toContain(tournamentId);
    expect(result.advanced).not.toContain(tournamentId);

    state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.blindLevel).toBe(0);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("should handle multiple tournaments: advance eligible, skip recent", async () => {
    const [player1, player2, player3, player4] = ctx.users;

    // Tournament A — due (old lastBlindAdvancedAt)
    const { tournamentId: tournA, tableId: tableA } = await createAndStartTournament(
      ctx,
      player1,
      [player2],
      { name: "Due Tournament" }
    );

    // Tournament B — recent (just started)
    const { tournamentId: tournB, tableId: tableB } = await createAndStartTournament(
      ctx,
      player3,
      [player4],
      { name: "Recent Tournament" }
    );

    // Backdate tournament A
    const pastTime = new Date(Date.now() - 10000);
    await ctx.app.prisma.tournament.update({
      where: { id: tournA },
      data: { lastBlindAdvancedAt: pastTime },
    });

    const result = await scanAndAdvanceTournamentBlinds(
      ctx.app.prisma,
      ctx.app.redis,
      silentLogger(),
      TEST_BLIND_INTERVAL_MS
    );

    expect(result.advanced).toContain(tournA);
    expect(result.skipped).not.toContain(tournA);
    expect(result.skipped).toContain(tournB);
    expect(result.advanced).not.toContain(tournB);

    const stateA = await getTableState(ctx.app, player1.token, tableA);
    expect(stateA.blindLevel).toBe(1);

    const stateB = await getTableState(ctx.app, player3.token, tableB);
    expect(stateB.blindLevel).toBe(0);

    await cleanupTestTable(ctx.app, tableA);
    await cleanupTestTable(ctx.app, tableB);
  });

  it("should not crash when tournament has no active tables", async () => {
    const [player1, player2] = ctx.users;
    const { tournamentId, tableId } = await createAndStartTournament(ctx, player1, [player2], {
      name: "No Tables Tournament",
    });

    const pastTime = new Date(Date.now() - 10000);
    await ctx.app.prisma.tournament.update({
      where: { id: tournamentId },
      data: { lastBlindAdvancedAt: pastTime },
    });

    // Close all tables
    await ctx.app.prisma.table.updateMany({
      where: { tournamentId },
      data: { status: "CLOSED" },
    });

    const result = await scanAndAdvanceTournamentBlinds(
      ctx.app.prisma,
      ctx.app.redis,
      silentLogger(),
      TEST_BLIND_INTERVAL_MS
    );

    expect(result.skipped).toContain(tournamentId);
    expect(result.advanced).not.toContain(tournamentId);

    // Restore for cleanup
    await ctx.app.prisma.table.updateMany({
      where: { tournamentId },
      data: { status: "ACTIVE" },
    });
    await cleanupTestTable(ctx.app, tableId);
  });
});
