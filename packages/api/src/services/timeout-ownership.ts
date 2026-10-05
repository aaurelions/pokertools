import type { Prisma } from "../../generated/prisma/index.js";
import type { AuthoritativeTable } from "./game-repository.js";

/**
 * Private scheduled-timeout ownership epoch.
 *
 * A committed `player-timeout` intent binds the canonical hand identity, the
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
  /** Canonical hand identity at deadline creation (`GameState.handId`). */
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
 * Upper bound on the state-mutating events scanned between a timeout anchor and
 * the current head. The legitimate case is a bounded number of blind-level
 * advances (the production blind interval is minutes, not milliseconds), so
 * exceeding this fails closed instead of loading unbounded history. The query
 * additionally excludes every known non-mutating projection in the database, so
 * chat/lifecycle traffic never counts against this bound.
 */
export const MAX_INTERVENING_TIMEOUT_EVENTS = 1024;

export type InterveningTimeoutEventClass = "benign-blind-advance" | "non-mutating" | "invalid";

/**
 * Classify one event appended after a timeout anchor. Only a real
 * `NEXT_BLIND_LEVEL` action is a benign state mutation; known non-mutating
 * lifecycle/chat projections are harmless. Every other action (TIME_BANK, a
 * betting action, a seat change, a new hand) invalidates the lease, and so does
 * an ACTION_APPLIED event that does not advance past the anchor version.
 */
export function classifyInterveningTimeoutEvent(
  event: { type: string; version: number; payload: unknown },
  anchorVersion: number
): InterveningTimeoutEventClass {
  if (event.type === "ACTION_APPLIED") {
    const action = (event.payload as { action?: unknown } | null | undefined)?.action;
    if (event.version > anchorVersion && action === "NEXT_BLIND_LEVEL") {
      return "benign-blind-advance";
    }
    return "invalid";
  }
  if (NON_MUTATING_INTERVENING_EVENT_TYPES.includes(event.type)) return "non-mutating";
  return "invalid";
}

/**
 * Authoritative ownership check, evaluated inside the manager's existing
 * transaction (same table lock and same authoritative load as the CAS):
 *
 * 1. the current authoritative snapshot is the same hand and the same player
 *    still owns the pending turn;
 * 2. the anchor event exists and its immutable version equals the legacy fence;
 * 3. every event between the anchor and the current head exists (no history
 *    gap), never regresses below the anchor version and never exceeds the
 *    current authoritative version;
 * 4. every intervening state-mutating event is a benign NEXT_BLIND_LEVEL.
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
  if (ownership.anchorEventSeq > record.eventSeq) return false;

  // Current ownership: same canonical hand, same actor still to act.
  if (snapshot.handId !== ownership.handId) return false;
  if (snapshot.actionTo === null) return false;
  const actor = snapshot.players[snapshot.actionTo];
  if (!actor || actor.id !== ownership.playerId) return false;

  // The anchor must be the immutable event created with the lease, carrying the
  // legacy version fence; a fabricated/future anchor is rejected.
  const anchor = await tx.gameEvent.findUnique({
    where: { tableId_eventSeq: { tableId, eventSeq: ownership.anchorEventSeq } },
    select: { eventSeq: true, version: true },
  });
  if (!anchor || anchor.version !== ownership.expectedVersion) return false;
  if (anchor.version > record.stateVersion) return false;

  const range = {
    tableId,
    eventSeq: { gt: ownership.anchorEventSeq, lte: record.eventSeq },
  };
  // Sequential on the transaction connection: interactive transactions execute
  // one query at a time, and this keeps the bounded scan deterministic.
  const aggregate = await tx.gameEvent.aggregate({
    where: range,
    _count: true,
    _min: { version: true },
    _max: { version: true },
  });
  const mutating = await tx.gameEvent.findMany({
    where: { ...range, type: { notIn: [...NON_MUTATING_INTERVENING_EVENT_TYPES] } },
    orderBy: { eventSeq: "asc" },
    select: { eventSeq: true, version: true, type: true, payload: true },
    take: MAX_INTERVENING_TIMEOUT_EVENTS + 1,
  });

  // Every seq in (anchor, head] must exist exactly once: a count mismatch is a
  // history gap (or a fabricated cursor) and fails closed.
  const interveningCount = record.eventSeq - ownership.anchorEventSeq;
  if (aggregate._count !== interveningCount) return false;
  if (interveningCount > 0) {
    if (aggregate._min.version === null || aggregate._min.version < ownership.expectedVersion) {
      return false; // version regression below the validated anchor
    }
    if (aggregate._max.version === null || aggregate._max.version > record.stateVersion) {
      return false; // fabricated/future lineage
    }
  }
  if (mutating.length > MAX_INTERVENING_TIMEOUT_EVENTS) return false;
  return mutating.every(
    (event) => classifyInterveningTimeoutEvent(event, ownership.expectedVersion) !== "invalid"
  );
}
