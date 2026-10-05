import { describe, expect, it, vi } from "vitest";
import {
  classifyInterveningTimeoutEvent,
  NON_MUTATING_INTERVENING_EVENT_TYPES,
  timeoutOwnershipHolds,
  type TimeoutOwnership,
} from "../../src/services/timeout-ownership.js";
import type { AuthoritativeTable } from "../../src/services/game-repository.js";

function record(overrides: Partial<AuthoritativeTable> = {}): AuthoritativeTable {
  return {
    id: "table-1",
    status: "ACTIVE",
    rawState: "{}",
    snapshot: {
      handId: "table-1_hand-1",
      actionTo: 0,
      players: [{ id: "player-1", seat: 0 }],
    } as never,
    stateVersion: 4,
    eventSeq: 6,
    ...overrides,
  };
}

function ownership(overrides: Partial<TimeoutOwnership> = {}): TimeoutOwnership {
  return {
    handId: "table-1_hand-1",
    anchorEventSeq: 2,
    expectedVersion: 2,
    playerId: "player-1",
    ...overrides,
  };
}

function event(eventSeq: number, version: number, type: string, payload: unknown = {}) {
  return { eventSeq, version, type, payload };
}

function mockTx(input: {
  anchor: { eventSeq: number; version: number } | null;
  intervening: ReturnType<typeof event>[];
  take?: number;
}) {
  return {
    gameEvent: {
      findUnique: vi.fn(async ({ where }: { where: { tableId_eventSeq: { eventSeq: number } } }) =>
        input.anchor && where.tableId_eventSeq.eventSeq === input.anchor.eventSeq
          ? input.anchor
          : null
      ),
      aggregate: vi.fn(async () => {
        const versions = input.intervening.map((item) => item.version);
        return {
          _count: input.intervening.length,
          _min: { version: versions.length > 0 ? Math.min(...versions) : null },
          _max: { version: versions.length > 0 ? Math.max(...versions) : null },
        };
      }),
      findMany: vi.fn(
        async ({ where }: { where: { type?: { notIn?: readonly string[] }; take?: number } }) =>
          input.intervening
            .filter((item) => !(where.type?.notIn ?? []).includes(item.type))
            .slice(0, where.take ?? input.take ?? 1000)
      ),
    },
  } as never;
}

describe("intervening timeout event classification", () => {
  it("treats only a later real NEXT_BLIND_LEVEL action as a benign state mutation", () => {
    expect(
      classifyInterveningTimeoutEvent(
        event(3, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
        2
      )
    ).toBe("benign-blind-advance");
    // A blind-level event at the anchor version cannot be a real mutation.
    expect(
      classifyInterveningTimeoutEvent(
        event(3, 2, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
        2
      )
    ).toBe("invalid");
  });

  it("invalidates real actions: TIME_BANK, betting actions, seat changes and new hands", () => {
    for (const [type, payload] of [
      ["ACTION_APPLIED", { action: "TIME_BANK" }],
      ["ACTION_APPLIED", { action: "CHECK" }],
      ["ACTION_APPLIED", { action: "FOLD" }],
      ["ACTION_APPLIED", { action: "SIT" }],
      ["ACTION_APPLIED", null],
      ["HAND_STARTED", {}],
      ["HAND_COMPLETED", {}],
      ["SEAT_OCCUPIED", { action: "SIT" }],
      ["SEAT_VACATED", { action: "STAND" }],
      ["SOMETHING_UNKNOWN", {}],
    ] as const) {
      expect(classifyInterveningTimeoutEvent(event(3, 3, type, payload), 2), type).toBe("invalid");
    }
  });

  it("allows only explicitly known non-mutating lifecycle/chat projections", () => {
    for (const type of NON_MUTATING_INTERVENING_EVENT_TYPES) {
      expect(classifyInterveningTimeoutEvent(event(3, 2, type, {}), 2), type).toBe("non-mutating");
      expect(classifyInterveningTimeoutEvent(event(3, 3, type, {}), 2), type).toBe("non-mutating");
    }
    expect(NON_MUTATING_INTERVENING_EVENT_TYPES).toContain("CHAT_MESSAGE");
    expect(NON_MUTATING_INTERVENING_EVENT_TYPES).toContain("TOURNAMENT_STARTED");
  });
});

describe("timeout ownership epoch", () => {
  it("holds across non-mutating lifecycle events and benign blind advances", async () => {
    const tx = mockTx({
      anchor: { eventSeq: 2, version: 2 },
      intervening: [
        event(3, 2, "TOURNAMENT_STARTED"),
        event(4, 2, "CHAT_MESSAGE"),
        event(5, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
        event(6, 4, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
      ],
    });
    await expect(timeoutOwnershipHolds(tx, "table-1", record(), ownership())).resolves.toBe(true);
  });

  it("rejects history gaps, version regression, fabricated future lineage and fake anchors", async () => {
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: { eventSeq: 2, version: 2 },
          intervening: [
            event(3, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
            // eventSeq 4 is missing
            event(5, 4, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: { eventSeq: 2, version: 2 },
          intervening: [
            event(3, 1, "CHAT_MESSAGE"),
            event(4, 2, "CHAT_MESSAGE"),
            event(5, 2, "CHAT_MESSAGE"),
            event(6, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: { eventSeq: 2, version: 2 },
          intervening: [
            event(3, 9, "CHAT_MESSAGE"),
            event(4, 9, "CHAT_MESSAGE"),
            event(5, 9, "CHAT_MESSAGE"),
            event(6, 9, "CHAT_MESSAGE"),
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: { eventSeq: 2, version: 3 },
          intervening: [
            event(3, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
            event(4, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
            event(5, 3, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
            event(6, 4, "ACTION_APPLIED", { action: "NEXT_BLIND_LEVEL" }),
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: null, intervening: [] }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);
  });

  it("rejects a different hand or a different acting player without touching history", async () => {
    const tx = mockTx({ anchor: { eventSeq: 2, version: 2 }, intervening: [] });
    await expect(
      timeoutOwnershipHolds(tx, "table-1", record(), ownership({ handId: "table-1_hand-2" }))
    ).resolves.toBe(false);
    await expect(
      timeoutOwnershipHolds(tx, "table-1", record(), ownership({ playerId: "player-2" }))
    ).resolves.toBe(false);
    await expect(
      timeoutOwnershipHolds(
        tx,
        "table-1",
        record({ snapshot: { handId: "table-1_hand-1", actionTo: null, players: [] } as never }),
        ownership()
      )
    ).resolves.toBe(false);
    await expect(
      timeoutOwnershipHolds(tx, "table-1", record(), ownership({ anchorEventSeq: 7 }))
    ).resolves.toBe(false);
    // An empty interval (head == anchor) with a matching anchor is valid.
    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: { eventSeq: 2, version: 2 }, intervening: [] }),
        "table-1",
        record({ eventSeq: 2 }),
        ownership()
      )
    ).resolves.toBe(true);
  });
});
