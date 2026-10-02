/// <reference path="../../types/fastify.d.ts" />
import { expect, it } from "vitest";
import type { PublicState } from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  getObservation,
  toCanonicalActionRequest,
} from "../helpers/test-utils.js";
import { persistSnapshotProjection } from "../../src/services/snapshot-projection.js";

it("preserves all-in contenders, merges 4 -> 2 -> 1 and settles through the API", async () => {
  const ctx = await initTestContext(8, 1000);
  const manager = ctx.users[0];
  const request = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    token = manager.token
  ) => {
    const response = await ctx.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
    return response.json();
  };
  try {
    const { tournamentId } = await request("POST", "/tournaments", {
      name: "Public elimination regression",
      buyIn: 100,
      fee: 0,
      startingStack: 20,
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 8,
      tableMaxPlayers: 2,
      payoutPercentages: [100],
    });
    for (const [seat, user] of ctx.users.entries()) {
      await request(
        "POST",
        `/tournaments/${tournamentId}/register`,
        {
          seat,
          idempotencyKey: `register-${tournamentId}-${seat}`,
        },
        user.token
      );
    }
    const { tableIds } = await request("POST", `/tournaments/${tournamentId}/start`);
    expect(tableIds).toHaveLength(4);
    const reconcile = () => request("POST", `/tournaments/${tournamentId}/reconcile`);
    const state = async (id: string): Promise<PublicState> =>
      (await request("GET", `/tables/${id}`)).state;
    const shove = async (id: string) => {
      const current = await state(id);
      const player = current.players[current.actionTo!]!;
      const actor = ctx.users.find((user) => user.id === player.id)!;
      const maxBet = Math.max(...current.players.map((candidate) => candidate?.betThisStreet ?? 0));
      const amount = player.stack + player.betThisStreet;
      // Resolve the server-issued legal action and submit canonically.
      const observation = await getObservation(ctx.app, actor.token, id);
      const payload = toCanonicalActionRequest(observation, {
        type: amount <= maxBet ? "CALL" : maxBet === 0 ? "BET" : "RAISE",
        ...(amount > maxBet ? { amount } : {}),
      });
      await request("POST", `/tables/${id}/action`, payload, actor.token);
    };
    // A zero-stack all-in contender is not eliminated before showdown.
    await shove(tableIds[0]);
    await reconcile();
    let details = (await request("GET", `/tournaments/${tournamentId}`)).tournament;
    expect(
      details.entries.filter((entry: { status: string }) => entry.status === "ACTIVE")
    ).toHaveLength(8);

    const counts = new Set<number>([4]);
    for (let round = 0; round < 100; round++) {
      details = (await request("GET", `/tournaments/${tournamentId}`)).tournament;
      const activeEntries = details.entries.filter(
        (entry: { status: string }) => entry.status === "ACTIVE"
      );
      if (activeEntries.length === 1) break;
      const tables = details.tables.filter(
        (table: { status: string }) => table.status !== "CLOSED"
      );
      for (const table of tables) {
        const assigned = activeEntries.filter(
          (entry: { currentTableId: string }) => entry.currentTableId === table.id
        );
        if (assigned.length < 2) continue;
        let current = await state(table.id);
        if (current.actionTo == null) {
          const dealer = ctx.users.find((user) => user.id === assigned[0].userId)!;
          const observation = await getObservation(ctx.app, dealer.token, table.id);
          const payload = toCanonicalActionRequest(observation, { type: "DEAL" });
          await request("POST", `/tables/${table.id}/action`, payload, dealer.token);
        }
        for (let action = 0; action < 10; action++) {
          current = await state(table.id);
          if (current.actionTo == null) break;
          await shove(table.id);
        }
        expect((await state(table.id)).actionTo).toBeNull();
        await reconcile();
        details = (await request("GET", `/tournaments/${tournamentId}`)).tournament;
        counts.add(
          details.tables.filter((candidate: { status: string }) => candidate.status !== "CLOSED")
            .length
        );
        for (const entry of details.entries.filter(
          (entry: { status: string }) => entry.status === "ACTIVE"
        )) {
          expect(
            details.tables.find(
              (candidate: { id: string }) => candidate.id === entry.currentTableId
            ).status
          ).not.toBe("CLOSED");
        }
      }
    }
    expect(counts.has(2)).toBe(true);
    expect(counts.has(1)).toBe(true);
    details = (await request("GET", `/tournaments/${tournamentId}`)).tournament;
    expect(
      details.entries.filter((entry: { status: string }) => entry.status === "ACTIVE")
    ).toHaveLength(1);
    const beforeRepeat = details.entries;
    await reconcile();
    expect((await request("GET", `/tournaments/${tournamentId}`)).tournament.entries).toEqual(
      beforeRepeat
    );
    const settled = await request("POST", `/tournaments/${tournamentId}/settle`);
    expect(settled.prize).toBe(800);
    const repeated = await request("POST", `/tournaments/${tournamentId}/settle`);
    expect(repeated.winnerUserId).toBe(settled.winnerUserId);
    for (const id of tableIds) {
      const before = await ctx.app.prisma.table.findUniqueOrThrow({ where: { id } });
      expect(before.status).toBe("CLOSED");
      // Reproduce a late queued snapshot arriving after closure.
      expect(await persistSnapshotProjection(ctx.app.prisma, id, { _version: 9999 })).toBe(false);
      expect(await ctx.app.prisma.table.findUniqueOrThrow({ where: { id } })).toEqual(before);
    }
  } finally {
    await runCleanup(ctx.cleanup);
  }
});
