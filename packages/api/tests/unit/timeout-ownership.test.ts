import { describe, expect, it, vi } from "vitest";
import {
  isLegitimateTimeoutAnchorEvent,
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

interface MockEvent {
  eventSeq: number;
  version: number;
  type: string;
  payload?: unknown;
}

function mockTx(input: {
  anchor: MockEvent | null;
  head: MockEvent | null;
  intervening: MockEvent[];
  invalid?: { eventSeq: number } | null;
}) {
  return {
    gameEvent: {
      findUnique: vi.fn(
        async ({ where }: { where: { tableId_eventSeq: { eventSeq: number } } }) => {
          const seq = where.tableId_eventSeq.eventSeq;
          if (input.anchor && input.anchor.eventSeq === seq) return input.anchor;
          if (input.head && input.head.eventSeq === seq) return input.head;
          return null;
        }
      ),
      aggregate: vi.fn(async () => {
        const versions = input.intervening.map((item) => item.version);
        return {
          _count: input.intervening.length,
          _min: { version: versions.length > 0 ? Math.min(...versions) : null },
          _max: { version: versions.length > 0 ? Math.max(...versions) : null },
        };
      }),
      findFirst: vi.fn(async () => input.invalid ?? null),
    },
  } as never;
}

const ANCHOR: MockEvent = { eventSeq: 2, version: 2, type: "HAND_STARTED" };
const HEAD: MockEvent = { eventSeq: 6, version: 4, type: "ACTION_APPLIED" };

describe("timeout anchor legitimacy", () => {
  it("accepts only mutations the producer can anchor a deadline at", () => {
    expect(isLegitimateTimeoutAnchorEvent(ANCHOR)).toBe(true);
    for (const type of ["SEAT_OCCUPIED", "SEAT_VACATED", "SEAT_RESERVED"]) {
      expect(isLegitimateTimeoutAnchorEvent({ type, payload: {} }), type).toBe(true);
    }
    for (const action of [
      "FOLD",
      "CHECK",
      "CALL",
      "BET",
      "RAISE",
      "SHOW",
      "MUCK",
      "TIMEOUT",
      "TIME_BANK",
    ]) {
      expect(
        isLegitimateTimeoutAnchorEvent({ type: "ACTION_APPLIED", payload: { action } }),
        action
      ).toBe(true);
    }
  });

  it("rejects blind advances, chat, lifecycle, hand completion and unknown anchors", () => {
    expect(
      isLegitimateTimeoutAnchorEvent({
        type: "ACTION_APPLIED",
        payload: { action: "NEXT_BLIND_LEVEL" },
      })
    ).toBe(false);
    expect(isLegitimateTimeoutAnchorEvent({ type: "ACTION_APPLIED", payload: {} })).toBe(false);
    expect(
      isLegitimateTimeoutAnchorEvent({ type: "ACTION_APPLIED", payload: { action: 42 } })
    ).toBe(false);
    for (const type of [
      "CHAT_MESSAGE",
      "HAND_COMPLETED",
      "TABLE_CREATED",
      "TOURNAMENT_STARTED",
      "SOMETHING_UNKNOWN",
    ]) {
      expect(isLegitimateTimeoutAnchorEvent({ type, payload: {} }), type).toBe(false);
    }
  });

  it("classifies exactly the documented non-mutating intervening types", () => {
    expect([...NON_MUTATING_INTERVENING_EVENT_TYPES].sort()).toEqual(
      [
        "CHAT_MESSAGE",
        "TABLE_CLOSED",
        "TOURNAMENT_CANCELLED",
        "TOURNAMENT_RECONCILED",
        "TOURNAMENT_SETTLED",
        "TOURNAMENT_STARTED",
      ].sort()
    );
  });
});

describe("timeout ownership epoch", () => {
  it("holds across a long benign blind-level history plus lifecycle/chat projections", async () => {
    const intervening: MockEvent[] = [
      { eventSeq: 3, version: 2, type: "TOURNAMENT_STARTED" },
      { eventSeq: 4, version: 2, type: "CHAT_MESSAGE" },
    ];
    for (let seq = 5; seq <= 6; seq += 1) {
      intervening.push({
        eventSeq: seq,
        version: seq - 2,
        type: "ACTION_APPLIED",
        payload: { action: "NEXT_BLIND_LEVEL" },
      });
    }
    const tx = mockTx({ anchor: ANCHOR, head: HEAD, intervening });
    await expect(timeoutOwnershipHolds(tx, "table-1", record(), ownership())).resolves.toBe(true);
  });

  it("rejects a non-benign action anywhere in the history through the database predicate", async () => {
    const tx = mockTx({
      anchor: ANCHOR,
      head: HEAD,
      intervening: [
        {
          eventSeq: 3,
          version: 3,
          type: "ACTION_APPLIED",
          payload: { action: "NEXT_BLIND_LEVEL" },
        },
        {
          eventSeq: 4,
          version: 3,
          type: "ACTION_APPLIED",
          payload: { action: "NEXT_BLIND_LEVEL" },
        },
        { eventSeq: 5, version: 3, type: "CHAT_MESSAGE" },
        {
          eventSeq: 6,
          version: 4,
          type: "ACTION_APPLIED",
          payload: { action: "NEXT_BLIND_LEVEL" },
        },
      ],
      invalid: { eventSeq: 4 },
    });
    await expect(timeoutOwnershipHolds(tx, "table-1", record(), ownership())).resolves.toBe(false);
  });

  it("rejects history gaps, below-anchor versions, versions beyond the head and cursor mismatch", async () => {
    // Gap: 4 of 5 events present.
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: ANCHOR,
          head: HEAD,
          intervening: [
            { eventSeq: 3, version: 3, type: "CHAT_MESSAGE" },
            { eventSeq: 5, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 6, version: 4, type: "CHAT_MESSAGE" },
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    // Version below the anchor.
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: ANCHOR,
          head: HEAD,
          intervening: [
            { eventSeq: 3, version: 1, type: "CHAT_MESSAGE" },
            { eventSeq: 4, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 5, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 6, version: 4, type: "CHAT_MESSAGE" },
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    // Version beyond the authoritative state version.
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: ANCHOR,
          head: HEAD,
          intervening: [
            { eventSeq: 3, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 4, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 5, version: 4, type: "CHAT_MESSAGE" },
            { eventSeq: 6, version: 9, type: "CHAT_MESSAGE" },
          ],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    // Head event disagrees with the authoritative stateVersion.
    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: ANCHOR, head: { ...HEAD, version: 3 }, intervening: [] }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);

    // Anchor ahead of the head / anchor missing / anchor version mismatch.
    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: ANCHOR, head: HEAD, intervening: [] }),
        "table-1",
        record(),
        ownership({ anchorEventSeq: 7 })
      )
    ).resolves.toBe(false);
    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: null, head: HEAD, intervening: [] }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);
    await expect(
      timeoutOwnershipHolds(
        mockTx({ anchor: { ...ANCHOR, version: 3 }, head: HEAD, intervening: [] }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);
  });

  it("rejects a different hand, a different actor, a null turn and a fake anchor mutation", async () => {
    const tx = mockTx({ anchor: ANCHOR, head: HEAD, intervening: [] });
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
    // The producer never anchors at a blind-metadata advance.
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: {
            eventSeq: 2,
            version: 2,
            type: "ACTION_APPLIED",
            payload: { action: "NEXT_BLIND_LEVEL" },
          },
          head: HEAD,
          intervening: [],
        }),
        "table-1",
        record(),
        ownership()
      )
    ).resolves.toBe(false);
  });

  it("holds for an empty interval when the anchor is the current head", async () => {
    await expect(
      timeoutOwnershipHolds(
        mockTx({
          anchor: { eventSeq: 6, version: 4, type: "ACTION_APPLIED", payload: { action: "CALL" } },
          head: HEAD,
          intervening: [],
        }),
        "table-1",
        record(),
        ownership({ anchorEventSeq: 6, expectedVersion: 4 })
      )
    ).resolves.toBe(true);
  });
});
