import crypto from "node:crypto";
import type { Prisma } from "../../generated/prisma/index.js";
import type { TournamentEvent, TournamentEventType } from "@pokertools/types";
import { canonicalJson } from "./game-events.js";
import type { GameDbClient } from "./game-repository.js";

/**
 * Durable, append-only, per-tournament canonical audit stream.
 *
 * Every accepted tournament lifecycle transition (start / reconcile / table
 * close / final settle) is recorded as an ordered `TournamentEvent`. The
 * `stateFingerprint` is unique per tournament, so a repeated reconcile or
 * settlement with the same accepted facts is a no-op: it cannot append a
 * spurious event or duplicate the settled economic payout. `hash` chains over
 * the canonical payload and `previousHash`, giving practical tamper evidence.
 *
 * Rows are inserted inside the same database transaction as the accepted facts
 * wherever the caller has one (e.g. final settlement), so the audit and the
 * facts commit together.
 */

export interface RecordTournamentEventInput {
  tournamentId: string;
  type: TournamentEventType;
  payload: Record<string, unknown>;
  stateFingerprint: string;
  requestRef?: string | null;
}

interface TournamentEventRow {
  id: string;
  tournamentId: string;
  eventSeq: number;
  type: string;
  payload: unknown;
  stateFingerprint: string;
  requestRef: string | null;
  previousHash: string | null;
  hash: string;
  occurredAt: Date;
}

/** Canonical hash over an event's accepted facts and chain link. */
export function hashTournamentEvent(input: {
  tournamentId: string;
  eventSeq: number;
  type: string;
  payload: unknown;
  stateFingerprint: string;
  requestRef: string | null;
  previousHash: string | null;
}): string {
  const body = canonicalJson({
    tournamentId: input.tournamentId,
    eventSeq: input.eventSeq,
    type: input.type,
    payload: input.payload,
    stateFingerprint: input.stateFingerprint,
    requestRef: input.requestRef,
  });
  return crypto
    .createHash("sha256")
    .update(`${input.previousHash ?? "GENESIS"}|${body}`)
    .digest("hex");
}

function toCanonicalTournamentEvent(row: TournamentEventRow): TournamentEvent {
  return {
    eventId: row.id,
    tournamentId: row.tournamentId,
    eventSeq: row.eventSeq,
    type: row.type as TournamentEventType,
    occurredAt: row.occurredAt.getTime(),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    stateFingerprint: row.stateFingerprint,
    requestRef: row.requestRef,
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

/**
 * Append one canonical tournament audit event, idempotent on
 * `(tournamentId, stateFingerprint)`. Repeating a reconcile or settlement with
 * the same accepted facts returns the existing event instead of duplicating it.
 */
export async function recordTournamentEvent(
  client: GameDbClient,
  input: RecordTournamentEventInput
): Promise<TournamentEvent> {
  const existing = await client.tournamentEvent.findUnique({
    where: {
      tournamentId_stateFingerprint: {
        tournamentId: input.tournamentId,
        stateFingerprint: input.stateFingerprint,
      },
    },
  });
  if (existing) return toCanonicalTournamentEvent(existing);

  const last = await client.tournamentEvent.findFirst({
    where: { tournamentId: input.tournamentId },
    orderBy: { eventSeq: "desc" },
    select: { eventSeq: true, hash: true },
  });
  const eventSeq = (last?.eventSeq ?? 0) + 1;
  const previousHash = last?.hash ?? null;
  const requestRef = input.requestRef ?? null;
  const hash = hashTournamentEvent({
    tournamentId: input.tournamentId,
    eventSeq,
    type: input.type,
    payload: input.payload,
    stateFingerprint: input.stateFingerprint,
    requestRef,
    previousHash,
  });

  try {
    const created = await client.tournamentEvent.create({
      data: {
        tournamentId: input.tournamentId,
        eventSeq,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        stateFingerprint: input.stateFingerprint,
        requestRef,
        previousHash,
        hash,
      },
    });
    return toCanonicalTournamentEvent(created);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // A concurrent writer recorded the same accepted facts first.
      const raced = await client.tournamentEvent.findUnique({
        where: {
          tournamentId_stateFingerprint: {
            tournamentId: input.tournamentId,
            stateFingerprint: input.stateFingerprint,
          },
        },
      });
      if (raced) return toCanonicalTournamentEvent(raced);
    }
    throw error;
  }
}

/** Ordered tournament audit events for a tournament (ascending eventSeq). */
export async function listTournamentEvents(
  client: GameDbClient,
  tournamentId: string,
  options: { fromEventSeq?: number; toEventSeq?: number; take?: number } = {}
): Promise<TournamentEvent[]> {
  const eventSeqRange =
    options.fromEventSeq !== undefined || options.toEventSeq !== undefined
      ? {
          ...(options.fromEventSeq !== undefined ? { gte: options.fromEventSeq } : {}),
          ...(options.toEventSeq !== undefined ? { lte: options.toEventSeq } : {}),
        }
      : undefined;
  const rows = await client.tournamentEvent.findMany({
    where: {
      tournamentId,
      ...(eventSeqRange ? { eventSeq: eventSeqRange } : {}),
    },
    orderBy: { eventSeq: "asc" },
    take: options.take ?? 500,
  });
  return rows.map(toCanonicalTournamentEvent);
}

/**
 * Verify a tournament audit chain: every hash is recomputed from its accepted
 * facts and link, the sequence is strictly contiguous, and a sliced stream is
 * anchored to the persisted hash of the record before it.
 */
export function verifyTournamentEventChain(
  tournamentId: string,
  events: readonly TournamentEvent[],
  options: { anchorHash?: string | null; expectedFirstSeq?: number } = {}
): boolean {
  if (events.length > 0 && options.expectedFirstSeq !== undefined) {
    if (events[0].eventSeq !== options.expectedFirstSeq) return false;
  }
  let prevHash: string | null = options.anchorHash ?? null;
  let prevSeq: number | null = null;
  for (const event of events) {
    if (event.tournamentId !== tournamentId) return false;
    if (prevSeq !== null && event.eventSeq !== prevSeq + 1) return false;
    if (event.previousHash !== prevHash) return false;
    const expected = hashTournamentEvent({
      tournamentId,
      eventSeq: event.eventSeq,
      type: event.type,
      payload: event.payload,
      stateFingerprint: event.stateFingerprint,
      requestRef: event.requestRef,
      previousHash: prevHash,
    });
    if (expected !== event.hash) return false;
    prevHash = event.hash;
    prevSeq = event.eventSeq;
  }
  return true;
}

/** Stable fingerprint of the accepted tournament reconciliation state. */
export function tournamentStateFingerprint(input: {
  status: string;
  entries: ReadonlyArray<{
    id: string;
    status: string;
    placement: number | null;
    currentTableId: string | null;
    currentSeat: number | null;
  }>;
  tables: ReadonlyArray<{ id: string; status: string }>;
}): string {
  const normalized = {
    status: input.status,
    entries: [...input.entries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        status: entry.status,
        placement: entry.placement,
        currentTableId: entry.currentTableId,
        currentSeat: entry.currentSeat,
      })),
    tables: [...input.tables].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return crypto.createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
