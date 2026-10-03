/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  initTestContext,
  runCleanup,
  cleanupTestTable,
  type TestContext,
} from "../helpers/test-utils.js";

/**
 * Legacy tournament surface vs generic competitions, and authoritative start
 * atomicity.
 *
 * The public `/tournaments/:id` lifecycle routes must never drive a tournament
 * that backs a generic competition (not even for an ADMIN); the internal shared
 * services used by CompetitionManager remain callable. A failure anywhere in
 * the legacy start transaction must roll back every seat, entry, created table
 * and status change.
 */

describe("Legacy tournament surface rejects competition-managed tournaments", () => {
  let ctx: TestContext;
  const tableIds: string[] = [];
  const competitionIds: string[] = [];

  beforeAll(async () => {
    ctx = await initTestContext(3, 20000);
  });

  afterAll(async () => {
    if (competitionIds.length > 0) {
      await ctx.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    }
    for (const tableId of tableIds) {
      await cleanupTestTable(ctx.app, tableId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("rejects start/reconcile/advance-blinds/settle for the creator and for an admin", async () => {
    const [creator, admin, player2] = ctx.users;
    await ctx.app.prisma.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });

    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Competition-backed legacy tournament",
        buyIn: 100,
        fee: 0,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body) as {
      tournamentId: string;
      tableId: string;
    };
    tableIds.push(tableId);

    for (const [index, player] of [creator, player2].entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode, registerResponse.body).toBe(200);
    }

    // Declared fixture: the tournament is the backing store of a competition.
    const competition = await ctx.app.prisma.competition.create({
      data: {
        name: "Backing competition",
        mode: "NONFINANCIAL",
        organizerId: creator.id,
        tournamentId,
        idempotencyKey: crypto.randomUUID(),
        requestHash: `fixture-${crypto.randomUUID()}`,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
      },
      select: { id: true },
    });
    competitionIds.push(competition.id);

    for (const actor of [creator, admin]) {
      for (const path of ["start", "reconcile", "advance-blinds", "settle"]) {
        const response = await ctx.app.inject({
          method: "POST",
          url: `/tournaments/${tournamentId}/${path}`,
          headers: { authorization: `Bearer ${actor.token}` },
        });
        expect(response.statusCode, `${path}: ${response.body}`).toBe(409);
        expect(JSON.parse(response.body).error).toBe("COMPETITION_MANAGED_TOURNAMENT");
      }
    }

    // Nothing was mutated by the rejected legacy calls.
    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      include: { entries: true },
    });
    expect(tournament.status).toBe("REGISTRATION");
    expect(tournament.entries.every((entry) => entry.status === "REGISTERED")).toBe(true);
  });
});

describe("Legacy tournament start is one authoritative transaction", () => {
  let ctx: TestContext;
  const tableIds: string[] = [];

  beforeAll(async () => {
    ctx = await initTestContext(4, 20000);
  });

  afterAll(async () => {
    for (const tableId of tableIds) {
      await cleanupTestTable(ctx.app, tableId);
    }
    await runCleanup(ctx.cleanup);
  });

  it("rolls back every seat, entry, created table and status change on a mid-start engine failure", async () => {
    const [creator, ...players] = ctx.users;
    const createResponse = await ctx.app.inject({
      method: "POST",
      url: "/tournaments",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: {
        name: "Atomic start tournament",
        buyIn: 100,
        fee: 0,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
        tableMaxPlayers: 2,
        payoutPercentages: [100],
      },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(200);
    const { tournamentId, tableId } = JSON.parse(createResponse.body) as {
      tournamentId: string;
      tableId: string;
    };
    tableIds.push(tableId);

    for (const [index, player] of [creator, ...players].entries()) {
      const registerResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/register`,
        headers: { authorization: `Bearer ${player.token}` },
        payload: { seat: index, idempotencyKey: crypto.randomUUID() },
      });
      expect(registerResponse.statusCode, registerResponse.body).toBe(200);
    }

    const original = ctx.app.gameManager.applyManagementMutationInTx.bind(ctx.app.gameManager);
    let calls = 0;
    const spy = vi
      .spyOn(ctx.app.gameManager, "applyManagementMutationInTx")
      .mockImplementation((async (...args: never[]) => {
        calls += 1;
        if (calls === 4) throw new Error("injected start engine failure");
        return original(...args);
      }) as never);
    let startResponse;
    try {
      startResponse = await ctx.app.inject({
        method: "POST",
        url: `/tournaments/${tournamentId}/start`,
        headers: { authorization: `Bearer ${creator.token}` },
      });
    } finally {
      spy.mockRestore();
    }
    expect(startResponse.statusCode).toBe(500);

    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      include: { entries: true },
    });
    expect(tournament.status).toBe("REGISTRATION");
    expect(tournament.startedAt).toBeNull();
    for (const entry of tournament.entries) {
      expect(entry.status).toBe("REGISTERED");
      expect(entry.currentTableId).toBeNull();
      expect(entry.currentSeat).toBeNull();
    }

    // The additional table created during the failed start rolled back with the
    // transaction: only the primary table exists, untouched.
    const tables = await ctx.app.prisma.table.findMany({ where: { tournamentId } });
    expect(tables.map((table) => table.id)).toEqual([tableId]);
    expect(tables[0].status).toBe("WAITING");
    expect(tables[0].stateVersion).toBe(0);
    expect(tables[0].eventSeq).toBe(1);
    expect(
      await ctx.app.prisma.gameEvent.count({
        where: { tableId, type: "SEAT_OCCUPIED" },
      })
    ).toBe(0);

    // A clean retry seats everyone and deals both tables exactly once.
    const retried = await ctx.app.inject({
      method: "POST",
      url: `/tournaments/${tournamentId}/start`,
      headers: { authorization: `Bearer ${creator.token}` },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    const body = JSON.parse(retried.body) as { tableIds: string[]; distribution: number[] };
    expect(body.distribution).toEqual([2, 2]);
    expect(body.tableIds).toHaveLength(2);
    tableIds.push(...body.tableIds.filter((id) => id !== tableId));
    for (const id of body.tableIds) {
      expect(
        await ctx.app.prisma.gameEvent.count({ where: { tableId: id, type: "SEAT_OCCUPIED" } })
      ).toBe(2);
      expect(
        await ctx.app.prisma.gameEvent.count({ where: { tableId: id, type: "HAND_STARTED" } })
      ).toBe(1);
    }
  });
});
