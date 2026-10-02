import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { Action, Snapshot as EngineSnapshot } from "@pokertools/engine";
import { ActionType } from "@pokertools/engine";
import {
  canonicalJson,
  sealEventBatch,
  type NewGameEvent,
  type PendingGameEvent,
} from "./game-events.js";

/**
 * Game repository — PostgreSQL-authoritative DB mechanics.
 *
 * The engine is a pure in-memory reducer; this module owns the durable
 * compare-and-set, idempotency records, ordered public events and the
 * transactional outbox. Redis is never the authority: the authoritative
 * snapshot is always the `Table.state` row read inside the mutation transaction.
 */

export type GameDbClient = PrismaClient | Prisma.TransactionClient;

export interface Snapshot extends EngineSnapshot {
  _version?: number;
}

export interface AuthoritativeTable {
  id: string;
  status: string;
  rawState: string | null;
  /** Null exactly when the durable `Table.state` column is empty/corrupt. */
  snapshot: Snapshot | null;
  stateVersion: number;
  eventSeq: number;
}

export type GameAuthorityCode =
  | "TABLE_NOT_FOUND"
  | "TABLE_CLOSED"
  | "GAME_CONFLICT"
  | "STALE_TURN"
  | "REQUEST_ID_CONFLICT"
  | "IDENTITY_MISMATCH"
  | "INVALID_CANONICAL_ACTION"
  | "SEAT_OCCUPIED"
  | "GAME_ACTION_REJECTED";

export class GameAuthorityError extends Error {
  readonly statusCode: number;
  readonly code: GameAuthorityCode;

  constructor(code: GameAuthorityCode, message: string, statusCode = 409) {
    super(message);
    this.name = "GameAuthorityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseSnapshot(raw: unknown): Snapshot {
  if (raw === null || raw === undefined) {
    throw new GameAuthorityError("TABLE_NOT_FOUND", "Table state not found", 404);
  }
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Snapshot;
  return parsed;
}

/** Read the authoritative snapshot + CAS/event cursors from the database. */
export async function loadAuthoritativeTable(
  client: GameDbClient,
  tableId: string
): Promise<AuthoritativeTable | null> {
  const table = await client.table.findUnique({
    where: { id: tableId },
    select: { id: true, state: true, status: true, stateVersion: true, eventSeq: true },
  });
  if (!table) return null;

  const snapshot = table.state === null ? null : parseSnapshot(table.state);
  if (snapshot) snapshot._version = table.stateVersion;
  return {
    id: table.id,
    status: table.status,
    rawState: typeof table.state === "string" ? table.state : null,
    snapshot,
    stateVersion: table.stateVersion,
    eventSeq: table.eventSeq,
  };
}

/**
 * Atomic compare-and-set on `Table.stateVersion` AND `Table.eventSeq`. The
 * event cursor is guarded independently because chat appends advance `eventSeq`
 * without changing `stateVersion`; a stale event cursor would otherwise reset
 * the append-only sequence. Also refuses to mutate a CLOSED table. Returns false
 * when another writer won the race.
 */
export async function compareAndSetState(
  tx: Prisma.TransactionClient,
  input: {
    tableId: string;
    expectedVersion: number;
    expectedEventSeq: number;
    newVersion: number;
    newSnapshot: Snapshot;
    newEventSeq: number;
  }
): Promise<boolean> {
  const result = await tx.table.updateMany({
    where: {
      id: input.tableId,
      stateVersion: input.expectedVersion,
      eventSeq: input.expectedEventSeq,
      status: { not: "CLOSED" },
    },
    data: {
      state: JSON.stringify(input.newSnapshot),
      stateVersion: input.newVersion,
      eventSeq: input.newEventSeq,
    },
  });
  return result.count === 1;
}

// ---------------------------------------------------------------------------
// Idempotency records
// ---------------------------------------------------------------------------

export async function findActionRequest(
  tx: Prisma.TransactionClient,
  tableId: string,
  requestId: string
) {
  return tx.gameActionRequest.findUnique({
    where: { tableId_requestId: { tableId, requestId } },
  });
}

export async function createActionRequest(
  tx: Prisma.TransactionClient,
  data: {
    tableId: string;
    requestId: string;
    principalId: string;
    turnId: string;
    actionId: string;
    expectedVersion: number;
    requestHash: string;
  }
): Promise<{ id: string }> {
  return tx.gameActionRequest.create({
    data: { ...data, status: "PROCESSING" },
    select: { id: true },
  });
}

export async function completeActionRequest(
  tx: Prisma.TransactionClient,
  id: string,
  data: {
    response: unknown;
    resultVersion: number;
    eventSeq: number;
  }
): Promise<void> {
  await tx.gameActionRequest.update({
    where: { id },
    data: {
      status: "COMPLETED",
      response: data.response as Prisma.InputJsonValue,
      resultVersion: data.resultVersion,
      eventSeq: data.eventSeq,
    },
  });
}

// ---------------------------------------------------------------------------
// Ordered events
// ---------------------------------------------------------------------------

/** Persist sealed events. Assumes the caller already won the CAS for `version`. */
export async function insertGameEvents(
  tx: Prisma.TransactionClient,
  tableId: string,
  events: readonly NewGameEvent[]
): Promise<void> {
  for (const event of events) {
    await tx.gameEvent.create({
      data: {
        tableId,
        eventSeq: event.eventSeq,
        version: event.version,
        turnId: event.turnId ?? null,
        requestId: event.requestId ?? null,
        actionId: event.actionId ?? null,
        type: event.type,
        payload: event.payload as Prisma.InputJsonValue,
        previousHash: event.previousHash,
        hash: event.hash,
      },
    });
  }
}

export function sealEvents(
  tableId: string,
  version: number,
  startSeq: number,
  previousHash: string | null,
  pending: readonly PendingGameEvent[]
): NewGameEvent[] {
  return sealEventBatch(tableId, version, startSeq, previousHash, pending);
}

export async function listGameEvents(
  client: GameDbClient,
  tableId: string,
  options: { fromEventSeq?: number; toEventSeq?: number; take?: number } = {}
) {
  return client.gameEvent.findMany({
    where: {
      tableId,
      ...(options.fromEventSeq !== undefined ? { eventSeq: { gte: options.fromEventSeq } } : {}),
      ...(options.toEventSeq !== undefined ? { eventSeq: { lte: options.toEventSeq } } : {}),
    },
    orderBy: { eventSeq: "asc" },
    take: options.take ?? 500,
  });
}

// ---------------------------------------------------------------------------
// Canonical action derivation
// ---------------------------------------------------------------------------

export function deriveTurnId(input: {
  tableId: string;
  handId: string;
  version: number;
  actionTo: number | null;
}): string {
  // Always non-empty: the canonical turn id is required to be a valid id even
  // when no seat is currently to act (terminal/hand-boundary observation).
  return `${input.tableId}:${input.handId}:${input.version}:${input.actionTo ?? "none"}`;
}

export function canonicalActionHash(input: {
  tableId: string;
  principalId: string;
  turnId: string;
  expectedVersion: number;
  actionId: string;
  amount?: number;
  cardIndices?: readonly number[];
}): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        tableId: input.tableId,
        principalId: input.principalId,
        turnId: input.turnId,
        expectedVersion: input.expectedVersion,
        actionId: input.actionId,
        amount: input.amount ?? null,
        cardIndices: input.cardIndices ? [...input.cardIndices] : null,
      })
    )
    .digest("hex");
}

/**
 * Reconstruct the engine action from the canonical legal-action family. The
 * opaque `actionId` is resolved by matching the current turn's legal actions;
 * only the family (and optional amount) is interpreted here.
 */
export function legalFamilyToEngineAction(
  family: string,
  principalId: string,
  amount: number | undefined,
  cardIndices?: readonly number[]
): Action {
  const requireAmount = (): number => {
    if (amount === undefined || !Number.isSafeInteger(amount) || amount < 0) {
      throw new GameAuthorityError(
        "INVALID_CANONICAL_ACTION",
        `Action ${family} requires a chip amount`,
        400
      );
    }
    return amount;
  };

  switch (family) {
    case "FOLD":
      return { type: ActionType.FOLD, playerId: principalId };
    case "CHECK":
      return { type: ActionType.CHECK, playerId: principalId };
    case "CALL":
      return amount === undefined
        ? { type: ActionType.CALL, playerId: principalId }
        : { type: ActionType.CALL, playerId: principalId, amount };
    case "BET":
      return { type: ActionType.BET, playerId: principalId, amount: requireAmount() };
    case "RAISE":
      return { type: ActionType.RAISE, playerId: principalId, amount: requireAmount() };
    case "SHOW":
      return cardIndices
        ? { type: ActionType.SHOW, playerId: principalId, cardIndices }
        : { type: ActionType.SHOW, playerId: principalId };
    case "MUCK":
      return { type: ActionType.MUCK, playerId: principalId };
    case "TIME_BANK":
      return { type: ActionType.TIME_BANK, playerId: principalId };
    case "STAND":
      return { type: ActionType.STAND, playerId: principalId };
    case "DEAL":
      return { type: ActionType.DEAL };
    case "NEXT_BLIND_LEVEL":
      return { type: ActionType.NEXT_BLIND_LEVEL };
    default:
      throw new GameAuthorityError(
        "INVALID_CANONICAL_ACTION",
        `Unknown canonical action family: ${family}`,
        400
      );
  }
}

/** Inverse mapping for internal event/idempotency records. */
export function engineActionToActionId(action: Action): string {
  return action.type;
}
