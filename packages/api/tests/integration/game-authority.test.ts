/// <reference path="../../types/fastify.d.ts" />
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/utils/prisma-client.js";
import { GameManager } from "../../src/services/game-manager.js";
import { verifyEventChain } from "../../src/services/game-events.js";
import { compareAndSetState } from "../../src/services/game-repository.js";
import { dispatchPendingOutbox, requeueFailedOutbox } from "../../src/services/game-outbox.js";
import { ActionType, ReplayFrameSchema, type CanonicalActionRequest } from "@pokertools/types";

/**
 * PostgreSQL-authoritative game mutation acceptance (SQLite deterministic).
 *
 * These exercise the game authority directly (no HTTP, no finance) so that CAS,
 * idempotency, outbox and event masking can be verified deterministically.
 * Redis is replaced with an instrumented fake: it is coordination/cache only.
 */

let prisma: PrismaClient;
const createdTables: string[] = [];

type FakeRedis = {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

function makeRedis(overrides: Partial<FakeRedis> = {}): FakeRedis {
  return {
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    quit: vi.fn(async () => "OK"),
    ...overrides,
  };
}

function makeQueues(addImpl: () => Promise<unknown> = async () => ({})) {
  const names = [
    "settle-hand",
    "archive-hand",
    "next-hand",
    "persist-snapshot",
    "player-timeout",
    "tournament-blinds",
  ];
  return Object.fromEntries(
    names.map((name) => [name, { add: vi.fn(addImpl), close: vi.fn(async () => undefined) }])
  ) as Record<string, { add: ReturnType<typeof vi.fn> }>;
}

function makeRedlock() {
  return {
    lock: vi.fn(async () => ({ unlock: vi.fn(async () => undefined) })),
  };
}

function buildManager(
  redis = makeRedis(),
  queues = makeQueues(),
  redlock = makeRedlock()
): { manager: GameManager; redis: FakeRedis; queues: ReturnType<typeof makeQueues> } {
  const manager = new GameManager(redis as never, redlock as never, queues as never, prisma);
  return { manager, redis, queues };
}

async function seedTable(
  manager: GameManager,
  principalIds: string[],
  name: string
): Promise<string> {
  const tableId = await manager.createTable({
    name,
    mode: "CASH",
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 6,
  });
  createdTables.push(tableId);
  for (let seat = 0; seat < principalIds.length; seat += 1) {
    await manager.processAction(
      tableId,
      {
        type: ActionType.SIT,
        playerId: principalIds[seat],
        playerName: principalIds[seat],
        seat,
        stack: 1000,
      },
      principalIds[seat],
      { skipLock: true }
    );
  }
  await manager.processAction(tableId, { type: ActionType.DEAL }, "", { skipLock: true });
  return tableId;
}

async function actingSeat(
  manager: GameManager,
  tableId: string,
  principalIds: string[]
): Promise<{ principalId: string; turnId: string; version: number; actionId: string }> {
  for (const principalId of principalIds) {
    const observation = await manager.getObservation(tableId, principalId);
    const legal = observation.legalActions.find((action) => action.family === "FOLD");
    if (legal) {
      return {
        principalId,
        turnId: observation.turnId,
        version: observation.version,
        actionId: legal.actionId,
      };
    }
  }
  throw new Error("No acting seat with a legal FOLD");
}

beforeAll(async () => {
  prisma = createPrismaClient();
  await prisma.$connect();
});

afterEach(async () => {
  const ids = createdTables.splice(0);
  if (ids.length > 0) {
    // GameEvent/GameActionRequest/GameOutbox cascade from Table.
    await prisma.table.deleteMany({ where: { id: { in: ids } } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PostgreSQL-authoritative game CAS", () => {
  it("accepts exactly one of two submissions at the same expectedVersion", async () => {
    const principals = ["sa-cas-a", "sa-cas-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "cas-race");
    const actor = await actingSeat(manager, tableId, principals);
    const base: Omit<CanonicalActionRequest, "requestId"> = {
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    };

    const results = await Promise.allSettled([
      manager.submitCanonicalAction(tableId, actor.principalId, { requestId: "race-1", ...base }),
      manager.submitCanonicalAction(tableId, actor.principalId, { requestId: "race-2", ...base }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const table = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(table.stateVersion).toBe(actor.version + 1);
    const durable = JSON.parse(table.state as string);
    expect(durable._version).toBe(actor.version + 1);
  });

  it("returns the exact stored result for an identical duplicate and rejects a different actor", async () => {
    const principals = ["sa-idem-a", "sa-idem-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "idem");
    const actor = await actingSeat(manager, tableId, principals);
    const request: CanonicalActionRequest = {
      requestId: "idem-1",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    };

    const first = await manager.submitCanonicalAction(tableId, actor.principalId, request);
    expect(first.replayed).toBe(false);

    // Turn has advanced; the identical duplicate still returns the original result.
    const replay = await manager.submitCanonicalAction(tableId, actor.principalId, request);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.observation).toEqual(first.observation);

    // A different principal presenting the same requestId must never receive the
    // actor's stored (private) observation.
    await expect(
      manager.submitCanonicalAction(tableId, principals[1], request)
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });

    const rows = await prisma.gameActionRequest.findMany({ where: { tableId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].principalId).toBe(actor.principalId);
    expect(rows[0].status).toBe("COMPLETED");
  });

  it("refuses malformed persisted responses without reapplying the action", async () => {
    const principals = ["sa-corrupt-a", "sa-corrupt-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "invalid-response");
    const actor = await actingSeat(manager, tableId, principals);
    const request: CanonicalActionRequest = {
      requestId: "corrupt-response",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    };
    await manager.submitCanonicalAction(tableId, actor.principalId, request);
    // SQLite allows corruption injection; PostgreSQL audit constraints forbid
    // editing committed requests. Validate on read as well as on write.
    await prisma.gameActionRequest.update({
      where: { tableId_requestId: { tableId, requestId: request.requestId } },
      data: { response: { receipt: { tableId }, observation: {} } },
    });
    const before = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    await expect(
      manager.submitCanonicalAction(tableId, actor.principalId, request)
    ).rejects.toThrow();
    const after = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.eventSeq).toBe(before.eventSeq);
  });

  it("treats a Redis failure after commit as a committed action and recovers the outbox", async () => {
    const principals = ["sa-redis-a", "sa-redis-b"];
    const downRedis = makeRedis({
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    const downQueues = makeQueues(async () => {
      throw new Error("queue down");
    });
    const { manager } = buildManager(downRedis, downQueues);
    const tableId = await seedTable(manager, principals, "redis-error");
    const actor = await actingSeat(manager, tableId, principals);

    // Must resolve even though pubsub/queue dispatch failed.
    const result = await manager.submitCanonicalAction(tableId, actor.principalId, {
      requestId: "redis-1",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    });
    expect(result.receipt.version).toBe(actor.version + 1);

    const table = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(table.stateVersion).toBe(actor.version + 1);

    const failed = await prisma.gameOutbox.findMany({
      where: { tableId, status: "FAILED" },
    });
    expect(failed.length).toBeGreaterThan(0);

    // Recovery: after Redis returns, re-drive the durable intents.
    const recoveredRedis = makeRedis();
    const recoveredQueues = makeQueues();
    await requeueFailedOutbox(prisma);
    await dispatchPendingOutbox(prisma, recoveredQueues as never, recoveredRedis as never, {
      tableId,
    });
    const dispatched = await prisma.gameOutbox.count({
      where: { tableId, status: "DISPATCHED" },
    });
    expect(dispatched).toBeGreaterThan(0);
  });

  it("emits only masked, ordered, hash-chained public events", async () => {
    const principals = ["sa-events-a", "sa-events-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "events");
    const actor = await actingSeat(manager, tableId, principals);
    await manager.submitCanonicalAction(tableId, actor.principalId, {
      requestId: "events-1",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    });

    const frame = await manager.replay(tableId, 1);
    expect(frame.events.length).toBeGreaterThan(0);
    expect(frame.chainValid).toBe(true);
    for (let i = 1; i < frame.events.length; i += 1) {
      expect(frame.events[i].eventSeq).toBeGreaterThan(frame.events[i - 1].eventSeq);
    }

    const seeded = await prisma.gameEvent.findMany({
      where: { tableId },
      orderBy: { eventSeq: "asc" },
    });
    expect(
      verifyEventChain(
        tableId,
        seeded.map((event) => ({
          eventSeq: event.eventSeq,
          version: event.version,
          type: event.type,
          payload: event.payload,
          previousHash: event.previousHash,
          hash: event.hash,
        }))
      )
    ).toBe(true);

    // No public event may carry the deck or a seat's hole cards.
    for (const event of frame.events) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toContain('"deck"');
      expect(serialized).not.toContain('"hand"');
    }

    // A spectator observation masks every seat's cards.
    const spectator = await manager.getObservation(tableId);
    for (const player of spectator.state.players) {
      if (!player) continue;
      expect(player.hand).toBeNull();
    }
  });

  it("does not reset the append-only event sequence when chat advances it mid-turn", async () => {
    const principals = ["sa-chat-a", "sa-chat-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "chat-seq");
    const actor = await actingSeat(manager, tableId, principals);

    const tableBefore = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    await manager.appendChat(tableId, actor.principalId, "hello table");
    const tableAfterChat = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(tableAfterChat.eventSeq).toBe(tableBefore.eventSeq + 1);
    expect(tableAfterChat.stateVersion).toBe(tableBefore.stateVersion);

    // The action's transaction reads the fresh event cursor, so it appends after
    // the chat event rather than overwriting/resetting the sequence.
    await manager.submitCanonicalAction(tableId, actor.principalId, {
      requestId: "chat-race-1",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    });
    const tableAfter = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(tableAfter.stateVersion).toBe(actor.version + 1);
    expect(tableAfter.eventSeq).toBeGreaterThan(tableAfterChat.eventSeq);

    // Direct proof the CAS guards the event cursor: a stale expectedEventSeq is
    // rejected even when stateVersion still matches.
    const staleSnapshot = JSON.parse(tableAfter.state as string);
    const staleAccepted = await prisma.$transaction(async (tx) =>
      compareAndSetState(tx, {
        tableId,
        expectedVersion: tableAfter.stateVersion,
        expectedEventSeq: tableAfter.eventSeq - 1,
        newVersion: tableAfter.stateVersion + 1,
        newSnapshot: staleSnapshot,
        newEventSeq: tableAfter.eventSeq,
      })
    );
    expect(staleAccepted).toBe(false);

    const chat = await manager.listChat(tableId);
    expect(chat.messages).toHaveLength(1);
    const frame = await manager.replay(tableId, 1);
    expect(frame.chainValid).toBe(true);
  });

  it("verifies sliced replay frames from the start anchor and detects tamper/missing sequence", async () => {
    const principals = ["sa-slice-a", "sa-slice-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "slice");
    const actor = await actingSeat(manager, tableId, principals);
    await manager.appendChat(tableId, actor.principalId, "first");
    await manager.appendChat(tableId, actor.principalId, "second");
    await manager.submitCanonicalAction(tableId, actor.principalId, {
      requestId: "slice-1",
      turnId: actor.turnId,
      expectedVersion: actor.version,
      actionId: actor.actionId,
    });

    // Full frame from genesis: valid, bounded by the table head, shared schema.
    const full = await manager.replay(tableId, 1);
    expect(full.chainValid).toBe(true);
    expect(full.anchorHash).toBeNull();
    expect(full.headEventSeq).toBe(full.toEventSeq);
    expect(full.events[0].eventId).toBeTruthy();
    expect(ReplayFrameSchema.safeParse(full).success).toBe(true);

    // A non-genesis slice is anchored to the persisted hash of the prior record
    // and its every hash is re-verified (not only frames starting at event 1).
    const start = full.events[1].eventSeq;
    const sliced = await manager.replay(tableId, start);
    expect(sliced.chainValid).toBe(true);
    expect(sliced.anchorHash).toBe(full.events[0].hash);
    expect(sliced.events[0].eventSeq).toBe(start);
    expect(ReplayFrameSchema.safeParse(sliced).success).toBe(true);

    // Tampering with a persisted payload without rehashing is detected.
    await prisma.gameEvent.update({
      where: { tableId_eventSeq: { tableId, eventSeq: start } },
      data: { payload: { injected: true } },
    });
    const tampered = await manager.replay(tableId, 1);
    expect(tampered.chainValid).toBe(false);
    expect(ReplayFrameSchema.safeParse(tampered).success).toBe(true);

    // A missing sequence (gap) breaks contiguity and linkage; the frame is not a
    // valid shared contract and does not claim validity.
    await prisma.gameEvent.delete({
      where: { tableId_eventSeq: { tableId, eventSeq: start } },
    });
    const missing = await manager.replay(tableId, 1);
    expect(missing.chainValid).toBe(false);
    expect(ReplayFrameSchema.safeParse(missing).success).toBe(false);
  });

  it("advances a timeout once and treats a stale expectedVersion as a no-op", async () => {
    const principals = ["sa-timeout-a", "sa-timeout-b"];
    const { manager } = buildManager();
    const tableId = await seedTable(manager, principals, "timeout");
    const actor = await actingSeat(manager, tableId, principals);

    const applied = await manager.processAction(
      tableId,
      { type: ActionType.TIMEOUT, playerId: actor.principalId },
      actor.principalId,
      { expectedVersion: actor.version }
    );
    expect(applied.version).toBe(actor.version + 1);

    const stale = await manager.processAction(
      tableId,
      { type: ActionType.TIMEOUT, playerId: actor.principalId },
      actor.principalId,
      { expectedVersion: actor.version }
    );
    expect(stale.version).toBe(actor.version + 1);

    const table = await prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    expect(table.stateVersion).toBe(actor.version + 1);
  });
});
