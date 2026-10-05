import type { Prisma } from "../../generated/prisma/index.js";
import type { AuthoritativeTable } from "./game-repository.js";

/**
 * Private scheduled-timeout ownership epoch.
 *
 * A committed `player-timeout` intent binds the existing table-scoped
 * `GameState.handId` (the raw engine hand identity; `canonicalHandIdentity`
 * is the next-hand-owned form of the same identity, not a second system), the
 * immutable `GameEvent.eventSeq` of the mutation that created the deadline, the
 * acting player and the legacy version fence (`expectedVersion`, which must
 * equal the anchor event's version). The manager validates the whole epoch
 * inside its existing table lock + PostgreSQL transaction against the
 * authoritative record, so a scheduled turn can only ever be timed out while
 * the exact hand/actor that scheduled it still owns the turn.
 *
 * Public canonical actions can never supply this metadata: it is a private
 * option passed only by the timeout worker from the committed outbox payload.
 */
export interface TimeoutOwnership {
  /** Existing table-scoped `GameState.handId` at deadline creation. */
  handId: string;
  /** `GameEvent.eventSeq` of the mutation that created the deadline. */
  anchorEventSeq: number;
  /** Legacy strict version fence: must equal the anchor event's version. */
  expectedVersion: number;
  /** The seat owner that must still be to act. */
  playerId: string;
}

/**
 * Event types that may be appended to the table stream WITHOUT advancing
 * `Table.stateVersion`: non-mutating projections over an already-validated
 * state (chat and the tournament lifecycle audit projections). Explicit known
 * classification only — an unknown type is never treated as harmless.
 */
export const NON_MUTATING_INTERVENING_EVENT_TYPES: readonly string[] = [
  "CHAT_MESSAGE",
  "TOURNAMENT_STARTED",
  "TOURNAMENT_RECONCILED",
  "TOURNAMENT_CANCELLED",
  "TABLE_CLOSED",
  "TOURNAMENT_SETTLED",
];

/**
 * Action payloads that can legitimately carry a deadline-creating mutation.
 * Every one of these appends a single ACTION_APPLIED event from the accepted
 * mutation; NEXT_BLIND_LEVEL is deliberately absent because the producer never
 * anchors a deadline at a blind-metadata advance.
 */
const DEADLINE_CREATING_ACTION_TYPES: readonly string[] = [
  "FOLD",
  "CHECK",
  "CALL",
  "BET",
  "RAISE",
  "SHOW",
  "MUCK",
  "TIMEOUT",
  "TIME_BANK",
];

/**
 * True when the anchor event could have been written by the deadline-creating
 * mutation itself. `planTimeout` runs only after a real hand start, a seat
 * mutation or a non-NBL action, so chat, lifecycle projections, blind-level
 * advances, hand completions and unknown types can never be a genuine anchor.
 */
export function isLegitimateTimeoutAnchorEvent(event: { type: string; payload: unknown }): boolean {
  switch (event.type) {
    case "HAND_STARTED":
    case "SEAT_OCCUPIED":
    case "SEAT_VACATED":
    case "SEAT_RESERVED":
      return true;
    case "ACTION_APPLIED": {
      const action = (event.payload as { action?: unknown } | null | undefined)?.action;
      return typeof action === "string" && DEADLINE_CREATING_ACTION_TYPES.includes(action);
    }
    default:
      return false;
  }
}

/**
 * Database predicate for an intervening event that is neither a real benign
 * `NEXT_BLIND_LEVEL` state mutation nor an explicitly classified non-mutating
 * projection. The scan returns at most one row regardless of how long a
 * legitimate blind-level history is (no row download, no arbitrary cap).
 *
 * The benign marker is the immutable `GameEvent.actionId` column rather than a
 * JSON path filter: Prisma's PostgreSQL client types `path` as `string[]` while
 * its SQLite client requires `string`, so no single JSON-path predicate is
 * provider-agnostic. `actionId` is exact here — the public canonical route
 * deliberately never offers NEXT_BLIND_LEVEL (see `getLegalActions`), so every
 * internal blind advance seals `actionId = "NEXT_BLIND_LEVEL"` and every real
 * action seals its own canonical action id or engine action type. Anything
 * else (including an ACTION_APPLIED at or below the anchor version) is invalid.
 */
export function invalidInterveningTimeoutEventWhere(anchorVersion: number) {
  return {
    AND: [
      {
        NOT: {
          type: "ACTION_APPLIED",
          actionId: "NEXT_BLIND_LEVEL",
          version: { gt: anchorVersion },
        },
      },
      { NOT: { type: { in: [...NON_MUTATING_INTERVENING_EVENT_TYPES] } } },
    ],
  };
}

/**
 * Authoritative ownership check, evaluated inside the manager's existing
 * transaction (same table lock and same authoritative load as the CAS):
 *
 * 1. the current authoritative snapshot is the same hand and the same player
 *    still owns the pending turn;
 * 2. the anchor event exists, its immutable version equals the legacy fence and
 *    it is a legitimate deadline-creation mutation (never NEXT_BLIND_LEVEL);
 * 3. the current head event agrees with the authoritative `stateVersion`, and
 *    every event between the anchor and the head exists (no history gap) with
 *    no version below the anchor and none above the current state version;
 * 4. no intervening state-mutating event is anything other than a benign
 *    NEXT_BLIND_LEVEL.
 *
 * Version monotonicity *within* the interval (e.g. 12 -> 11) is not re-derived
 * here: `GameEvent` is append-only and every mutation seals its events with the
 * CAS-guarded `newVersion`, so a non-monotonic log cannot be produced without
 * corrupting the hash chain and the writer invariant. The bounds checked here
 * reject fabricated cursors that fall outside the immutable envelope.
 */
export async function timeoutOwnershipHolds(
  tx: Prisma.TransactionClient,
  tableId: string,
  record: AuthoritativeTable,
  ownership: TimeoutOwnership
): Promise<boolean> {
  const snapshot = record.snapshot;
  if (!snapshot) return false;
  if (!Number.isSafeInteger(ownership.anchorEventSeq) || ownership.anchorEventSeq < 1) return false;
  if (!Number.isSafeInteger(ownership.expectedVersion) || ownership.expectedVersion < 0) {
    return false;
  }
  if (ownership.anchorEventSeq > record.eventSeq || record.eventSeq < 1) return false;

  // Current ownership: same existing hand identity, same actor still to act.
  if (snapshot.handId !== ownership.handId) return false;
  if (snapshot.actionTo === null) return false;
  const actor = snapshot.players[snapshot.actionTo];
  if (!actor || actor.id !== ownership.playerId) return false;

  // The anchor must be the immutable event created with the lease, carrying the
  // legacy version fence, and must be a real deadline-creation mutation.
  const anchor = await tx.gameEvent.findUnique({
    where: { tableId_eventSeq: { tableId, eventSeq: ownership.anchorEventSeq } },
    select: { eventSeq: true, version: true, type: true, payload: true },
  });
  if (!anchor || anchor.version !== ownership.expectedVersion) return false;
  if (anchor.version > record.stateVersion) return false;
  if (!isLegitimateTimeoutAnchorEvent(anchor)) return false;

  // The authoritative head event must agree with the CAS cursors the manager
  // loaded; a fabricated eventSeq cursor is rejected before any lineage check.
  const head = await tx.gameEvent.findUnique({
    where: { tableId_eventSeq: { tableId, eventSeq: record.eventSeq } },
    select: { version: true },
  });
  if (!head || head.version !== record.stateVersion) return false;

  const range = {
    tableId,
    eventSeq: { gt: ownership.anchorEventSeq, lte: record.eventSeq },
  };
  const aggregate = await tx.gameEvent.aggregate({
    where: range,
    _count: true,
    _min: { version: true },
    _max: { version: true },
  });

  // Every seq in (anchor, head] must exist exactly once: a count mismatch is a
  // history gap (or a fabricated cursor) and fails closed.
  const interveningCount = record.eventSeq - ownership.anchorEventSeq;
  if (aggregate._count !== interveningCount) return false;
  if (interveningCount > 0) {
    if (aggregate._min.version === null || aggregate._min.version < ownership.expectedVersion) {
      return false; // version below the validated anchor
    }
    if (aggregate._max.version === null || aggregate._max.version > record.stateVersion) {
      return false; // version beyond the authoritative head
    }
  }

  // Single database-predicate probe: any real action, TIME_BANK renewal, seat
  // change, new hand or unknown event invalidates the lease. The query returns
  // at most one row and never downloads the (possibly long) benign history.
  const invalid = await tx.gameEvent.findFirst({
    where: { ...range, ...invalidInterveningTimeoutEventWhere(ownership.expectedVersion) },
    select: { eventSeq: true },
  });
  return invalid === null;
}
