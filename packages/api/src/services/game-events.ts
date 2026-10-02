import crypto from "node:crypto";
import type { Action, GameState } from "@pokertools/engine";
import type { CanonicalEventType } from "@pokertools/types";

/**
 * Durable public event projection + hash chain.
 *
 * Events are the immutable, strictly ordered public record of table mutations.
 * Payloads are built from the public engine surface only: they must never carry
 * the deck order, undealt cards, or another player's hole cards. The hash chain
 * (previousHash + canonical payload) gives practical sequence/tamper evidence.
 *
 * `TableEvent` in @pokertools/types is the wire shape; the DB row additionally
 * carries the chain columns and the idempotency correlation (turn/request/action).
 */

export interface PendingGameEvent {
  type: CanonicalEventType;
  payload: Record<string, unknown>;
  turnId?: string | null;
  requestId?: string | null;
  actionId?: string | null;
}

export interface NewGameEvent extends PendingGameEvent {
  eventSeq: number;
  version: number;
  previousHash: string | null;
  hash: string;
}

/** Deterministic JSON with sorted object keys (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashGameEvent(input: {
  tableId: string;
  eventSeq: number;
  version: number;
  type: string;
  payload: unknown;
  previousHash: string | null;
}): string {
  const body = canonicalJson({
    tableId: input.tableId,
    eventSeq: input.eventSeq,
    version: input.version,
    type: input.type,
    payload: input.payload,
  });
  return crypto
    .createHash("sha256")
    .update(`${input.previousHash ?? "GENESIS"}|${body}`)
    .digest("hex");
}

/** Assign sequence numbers and chain hashes to a batch of pending events. */
export function sealEventBatch(
  tableId: string,
  version: number,
  startSeq: number,
  previousHash: string | null,
  pending: readonly PendingGameEvent[]
): NewGameEvent[] {
  const sealed: NewGameEvent[] = [];
  let seq = startSeq;
  let prev = previousHash;
  for (const event of pending) {
    const hash = hashGameEvent({
      tableId,
      eventSeq: seq,
      version,
      type: event.type,
      payload: event.payload,
      previousHash: prev,
    });
    sealed.push({ ...event, eventSeq: seq, version, previousHash: prev, hash });
    prev = hash;
    seq += 1;
  }
  return sealed;
}

/**
 * Verify a contiguous, ordered event chain persisted for a table.
 *
 * Every event's hash is recomputed from its canonical body plus the previous
 * link, so a tampered payload or hash fails. Sequence numbers must be strictly
 * contiguous (+1 steps) so a missing or reordered event fails. For a slice that
 * does not start at genesis, pass the persisted `hash` of the record before the
 * slice as `options.anchorHash`; the first event must chain to it.
 */
export function verifyEventChain(
  tableId: string,
  events: ReadonlyArray<{
    eventSeq: number;
    version: number;
    type: string;
    payload: unknown;
    previousHash: string | null;
    hash: string;
  }>,
  options: { anchorHash?: string | null; expectedFirstSeq?: number } = {}
): boolean {
  if (events.length > 0 && options.expectedFirstSeq !== undefined) {
    if (events[0].eventSeq !== options.expectedFirstSeq) return false;
  }
  let prevHash: string | null = options.anchorHash ?? null;
  let prevSeq: number | null = null;
  for (const event of events) {
    if (prevSeq !== null && event.eventSeq !== prevSeq + 1) return false;
    if (event.previousHash !== prevHash) return false;
    const expected = hashGameEvent({
      tableId,
      eventSeq: event.eventSeq,
      version: event.version,
      type: event.type,
      payload: event.payload,
      previousHash: prevHash,
    });
    if (expected !== event.hash) return false;
    prevHash = event.hash;
    prevSeq = event.eventSeq;
  }
  return true;
}

/** Map an engine action to the canonical public event type. */
export function actionEventType(action: Action): CanonicalEventType {
  switch (action.type) {
    case "SIT":
      return "SEAT_OCCUPIED";
    case "STAND":
      return "SEAT_VACATED";
    case "RESERVE_SEAT":
      return "SEAT_RESERVED";
    case "DEAL":
      return "HAND_STARTED";
    default:
      return "ACTION_APPLIED";
  }
}

function seatOf(state: GameState, playerId: string): number | null {
  const player = state.players.find((candidate) => candidate?.id === playerId);
  return player ? player.seat : null;
}

/** Public payload for an applied action (no cards, no deck). */
export function buildActionEvent(action: Action, state: GameState): PendingGameEvent {
  const payload: Record<string, unknown> = {
    action: action.type,
    street: state.street,
    handId: state.handId,
    handNumber: state.handNumber,
    actionTo: state.actionTo,
    potTotal: state.pots.reduce((sum, pot) => sum + pot.amount, 0),
  };
  if ("playerId" in action) {
    payload.principalId = action.playerId;
    payload.seat = seatOf(state, action.playerId);
  }
  if ("amount" in action && typeof action.amount === "number") {
    payload.amount = action.amount;
  }
  if (action.type === "SIT" && "seat" in action) {
    payload.seat = action.seat;
    payload.stack = action.stack;
    payload.name = action.playerName;
  }
  if (action.type === "SHOW" && "cardIndices" in action && action.cardIndices) {
    payload.cardIndices = [...action.cardIndices];
  }
  return { type: actionEventType(action), payload };
}

export function buildHandStartedEvent(state: GameState): PendingGameEvent {
  return {
    type: "HAND_STARTED",
    payload: {
      handId: state.handId,
      handNumber: state.handNumber,
      buttonSeat: state.buttonSeat,
      smallBlind: state.smallBlind,
      bigBlind: state.bigBlind,
      ante: state.ante,
      seats: state.players
        .filter((player): player is NonNullable<typeof player> => player !== null)
        .map((player) => ({ seat: player.seat, principalId: player.id, stack: player.stack })),
    },
  };
}

/**
 * Public payload for a completed hand. `winners[].handRank` is included but the
 * concrete five-card hand is deliberately omitted so no hole cards leak into the
 * public stream.
 */
export function buildHandCompletedEvent(state: GameState): PendingGameEvent {
  return {
    type: "HAND_COMPLETED",
    payload: {
      handId: state.handId,
      handNumber: state.handNumber,
      board: [...state.board],
      rake: state.rakeThisHand,
      winners: (state.winners ?? []).map((winner) => ({
        seat: winner.seat,
        amount: winner.amount,
        handRank: winner.handRank,
      })),
    },
  };
}

export function buildChatEvent(input: {
  messageId: string;
  handId: string;
  principalId: string;
  body: string;
  sentAt: number;
}): PendingGameEvent {
  return {
    type: "CHAT_MESSAGE",
    payload: {
      messageId: input.messageId,
      handId: input.handId,
      principalId: input.principalId,
      body: input.body,
      sentAt: input.sentAt,
    },
  };
}

export function buildTableCreatedEvent(config: Record<string, unknown>): PendingGameEvent {
  return { type: "TABLE_CREATED", payload: { config } };
}
