/// <reference path="../../types/fastify.d.ts" />
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/utils/prisma-client.js";
import { GameManager } from "../../src/services/game-manager.js";
import { ReplayFrameSchema } from "@pokertools/types";
import {
  listTournamentEvents,
  recordTournamentEvent,
  tournamentStateFingerprint,
  verifyTournamentEventChain,
} from "../../src/services/tournament-events.js";

/**
 * Durable tournament audit: append-only, ordered, idempotent by accepted-state
 * fingerprint. Repeating a reconcile or settle must never append a spurious
 * event or duplicate an economic payout reference, and a replay must carry the
 * associated tournament transitions/settlement refs.
 */

let prisma: PrismaClient;
const createdTables: string[] = [];
const createdUsers: string[] = [];

function makeRedis() {
  return {
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    quit: vi.fn(async () => "OK"),
  };
}

function makeQueues() {
  const names = [
    "settle-hand",
    "archive-hand",
    "next-hand",
    "persist-snapshot",
    "player-timeout",
    "tournament-blinds",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      { add: vi.fn(async () => ({})), close: vi.fn(async () => undefined) },
    ])
  ) as never;
}

function makeRedlock() {
  return { lock: vi.fn(async () => ({ unlock: vi.fn(async () => undefined) })) };
}

async function seedTournament(): Promise<string> {
  const user = await prisma.user.create({
    data: { username: `te-user-${crypto.randomUUID()}` },
  });
  createdUsers.push(user.id);
  const table = await prisma.table.create({
    data: { name: `te-table-${crypto.randomUUID()}`, mode: "TOURNAMENT", config: {} },
  });
  createdTables.push(table.id);
  const tournament = await prisma.tournament.create({
    data: {
      name: `te-${crypto.randomUUID()}`,
      creatorId: user.id,
      tableId: table.id,
      buyIn: 100,
      startingStack: 1000,
      maxPlayers: 4,
      tableMaxPlayers: 4,
      blindStructure: [{ smallBlind: 5, bigBlind: 10, ante: 0 }],
      payoutPercentages: [100],
    },
  });
  return tournament.id;
}

beforeAll(async () => {
  prisma = createPrismaClient();
  await prisma.$connect();
});

afterEach(async () => {
  const tables = createdTables.splice(0);
  if (tables.length > 0) {
    // GameEvent/GameActionRequest/GameOutbox and Tournament/TournamentEvent
    // cascade from Table.
    await prisma.table.deleteMany({ where: { id: { in: tables } } });
  }
  const users = createdUsers.splice(0);
  if (users.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("durable tournament audit", () => {
  it("is append-only and ordered, and repeating reconcile/settle appends no duplicate", async () => {
    const tournamentId = await seedTournament();

    const started = await recordTournamentEvent(prisma, {
      tournamentId,
      type: "TOURNAMENT_STARTED",
      payload: { players: 2 },
      stateFingerprint: "started:2",
      requestRef: "op-1",
    });
    const startedAgain = await recordTournamentEvent(prisma, {
      tournamentId,
      type: "TOURNAMENT_STARTED",
      payload: { players: 2 },
      stateFingerprint: "started:2",
      requestRef: "op-1",
    });
    expect(startedAgain.eventId).toBe(started.eventId);
    expect(started.eventSeq).toBe(1);

    // Two reconciles accepting the same facts share a fingerprint => one event.
    const runningFingerprint = tournamentStateFingerprint({
      status: "RUNNING",
      entries: [
        {
          id: "e1",
          status: "ACTIVE",
          placement: null,
          currentTableId: "t1",
          currentSeat: 0,
        },
      ],
      tables: [{ id: "t1", status: "ACTIVE" }],
    });
    const reconcile1 = await recordTournamentEvent(prisma, {
      tournamentId,
      type: "TOURNAMENT_RECONCILED",
      payload: { status: "RUNNING" },
      stateFingerprint: runningFingerprint,
      requestRef: "op-1",
    });
    const reconcileRepeat = await recordTournamentEvent(prisma, {
      tournamentId,
      type: "TOURNAMENT_RECONCILED",
      payload: { status: "RUNNING" },
      stateFingerprint: runningFingerprint,
      requestRef: "op-1",
    });
    expect(reconcileRepeat.eventId).toBe(reconcile1.eventId);

    // A genuinely changed state appends the next ordered event.
    const movedFingerprint = tournamentStateFingerprint({
      status: "RUNNING",
      entries: [
        {
          id: "e1",
          status: "ACTIVE",
          placement: null,
          currentTableId: "t2",
          currentSeat: 1,
        },
      ],
      tables: [
        { id: "t1", status: "CLOSED" },
        { id: "t2", status: "ACTIVE" },
      ],
    });
    const reconcileMoved = await recordTournamentEvent(prisma, {
      tournamentId,
      type: "TOURNAMENT_RECONCILED",
      payload: { status: "RUNNING" },
      stateFingerprint: movedFingerprint,
      requestRef: "op-1",
    });
    expect(reconcileMoved.eventSeq).toBe(reconcile1.eventSeq + 1);

    // Repeating a settlement with the same payout references is idempotent.
    const settleInput = {
      tournamentId,
      type: "TOURNAMENT_SETTLED" as const,
      payload: {
        winnerUserId: "w1",
        payouts: [{ userId: "w1", placement: 1, amount: 400 }],
      },
      stateFingerprint: `settled:${tournamentId}`,
      requestRef: "op-1",
    };
    const settled = await recordTournamentEvent(prisma, settleInput);
    const settledRepeat = await recordTournamentEvent(prisma, settleInput);
    expect(settledRepeat.eventId).toBe(settled.eventId);

    const events = await listTournamentEvents(prisma, tournamentId);
    expect(events.map((event) => event.type)).toEqual([
      "TOURNAMENT_STARTED",
      "TOURNAMENT_RECONCILED",
      "TOURNAMENT_RECONCILED",
      "TOURNAMENT_SETTLED",
    ]);
    expect(events.map((event) => event.eventSeq)).toEqual([1, 2, 3, 4]);
    expect(events.filter((event) => event.type === "TOURNAMENT_SETTLED")).toHaveLength(1);
    expect(verifyTournamentEventChain(tournamentId, events)).toBe(true);
  });

  it("verifies sliced chains from an anchor and detects tampering", async () => {
    const tournamentId = await seedTournament();
    for (let i = 0; i < 3; i += 1) {
      await recordTournamentEvent(prisma, {
        tournamentId,
        type: "TOURNAMENT_RECONCILED",
        payload: { step: i },
        stateFingerprint: `reconcile:${i}`,
        requestRef: "op-1",
      });
    }
    const events = await listTournamentEvents(prisma, tournamentId);
    expect(verifyTournamentEventChain(tournamentId, events)).toBe(true);
    // A non-genesis slice verifies against the prior record's hash anchor.
    expect(
      verifyTournamentEventChain(tournamentId, events.slice(1), {
        anchorHash: events[0].hash,
        expectedFirstSeq: events[1].eventSeq,
      })
    ).toBe(true);
    // Tampering with a persisted payload is detected.
    await prisma.tournamentEvent.update({
      where: { id: events[1].eventId },
      data: { payload: { tampered: true } },
    });
    const tampered = await listTournamentEvents(prisma, tournamentId);
    expect(verifyTournamentEventChain(tournamentId, tampered)).toBe(false);
  });

  it("carries associated tournament transitions/settlement refs in the table replay", async () => {
    const manager = new GameManager(
      makeRedis() as never,
      makeRedlock() as never,
      makeQueues(),
      prisma
    );
    const tableId = await manager.createTable({
      name: `te-replay-${crypto.randomUUID()}`,
      mode: "TOURNAMENT",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 4,
      startingStack: 1000,
    });
    createdTables.push(tableId);

    const user = await prisma.user.create({
      data: { username: `te-replay-${crypto.randomUUID()}` },
    });
    createdUsers.push(user.id);
    const tournament = await prisma.tournament.create({
      data: {
        name: `te-replay-${crypto.randomUUID()}`,
        creatorId: user.id,
        tableId,
        buyIn: 100,
        startingStack: 1000,
        maxPlayers: 4,
        tableMaxPlayers: 4,
        blindStructure: [{ smallBlind: 5, bigBlind: 10, ante: 0 }],
        payoutPercentages: [100],
      },
    });
    await prisma.table.update({ where: { id: tableId }, data: { tournamentId: tournament.id } });
    await recordTournamentEvent(prisma, {
      tournamentId: tournament.id,
      type: "TOURNAMENT_STARTED",
      payload: { players: 0, tableIds: [tableId], distribution: [] },
      stateFingerprint: "started:replay",
      requestRef: "op-1",
    });

    const frame = await manager.replay(tableId, 1);
    expect(ReplayFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.tournamentEvents?.map((event) => event.type)).toEqual(["TOURNAMENT_STARTED"]);
  });
});
