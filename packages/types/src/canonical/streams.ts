import { z } from "zod";
import {
  CounterSchema,
  EpochMillisSchema,
  HandIdSchema,
  IdSchema,
  PrincipalIdSchema,
  TableIdSchema,
} from "./primitives";
import { PublicWireStateSchema } from "./masked-state";

/**
 * Append-only table streams: ordered events, bounded chat and replay frames.
 *
 * Streams are strictly ordered by `eventSeq`. Records are immutable once
 * written; a replay frame is a contiguous slice of the same ordering.
 */

export const CanonicalEventTypeSchema = z.enum([
  "TABLE_CREATED",
  "SEAT_RESERVED",
  "SEAT_OCCUPIED",
  "SEAT_VACATED",
  "HAND_STARTED",
  "ACTION_APPLIED",
  "HAND_COMPLETED",
  "CHAT_MESSAGE",
  "DEPOSIT_CREDITED",
  "WITHDRAWAL_STATUS",
  "INCIDENT_OPENED",
  "INCIDENT_RESOLVED",
]);
export type CanonicalEventType = z.infer<typeof CanonicalEventTypeSchema>;

/** A single immutable table event. */
export const TableEventSchema = z.strictObject({
  eventId: IdSchema,
  tableId: TableIdSchema,
  eventSeq: CounterSchema,
  version: CounterSchema,
  type: CanonicalEventTypeSchema,
  occurredAt: EpochMillisSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type TableEvent = z.infer<typeof TableEventSchema>;

/** True when events are strictly ordered by `eventSeq` (append-only order). */
export function isAppendOnlyEventStream(events: readonly TableEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i].eventSeq <= events[i - 1].eventSeq) return false;
  }
  return true;
}

/**
 * A public chat message. `handId` binds the message to the authoritative hand
 * at append time; chat never advances the table state version.
 */
export const ChatMessageSchema = z.strictObject({
  messageId: IdSchema,
  tableId: TableIdSchema,
  handId: HandIdSchema,
  eventSeq: CounterSchema,
  principalId: PrincipalIdSchema,
  body: z.string().min(1).max(2000),
  sentAt: EpochMillisSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** A page of chat history, oldest-first within the page. */
export const ChatPageSchema = z.strictObject({
  tableId: TableIdSchema,
  messages: z.array(ChatMessageSchema),
  nextBeforeSeq: CounterSchema.nullable(),
});
export type ChatPage = z.infer<typeof ChatPageSchema>;

/**
 * Durable, append-only, ordered canonical tournament audit event.
 *
 * Records the accepted facts of a tournament lifecycle transition
 * (`TOURNAMENT_STARTED` / `TOURNAMENT_RECONCILED` / `TOURNAMENT_CANCELLED` /
 * `TABLE_CLOSED` / `TOURNAMENT_SETTLED`) with a stable `stateFingerprint` so a
 * repeated reconcile or settlement cannot append a spurious event or duplicate
 * the settled economic payout. `requestRef` optionally references the accepted
 * operator request/actor.
 */
export const TournamentEventTypeSchema = z.enum([
  "TOURNAMENT_STARTED",
  "TOURNAMENT_RECONCILED",
  "TOURNAMENT_CANCELLED",
  "TABLE_CLOSED",
  "TOURNAMENT_SETTLED",
]);
export type TournamentEventType = z.infer<typeof TournamentEventTypeSchema>;

export const TournamentEventSchema = z.strictObject({
  eventId: IdSchema,
  tournamentId: IdSchema,
  eventSeq: CounterSchema,
  type: TournamentEventTypeSchema,
  occurredAt: EpochMillisSchema,
  payload: z.record(z.string(), z.unknown()),
  stateFingerprint: z.string().min(1).max(256),
  requestRef: z.string().min(1).max(256).nullable(),
  previousHash: z.string().min(1).nullable(),
  hash: z.string().min(1),
});
export type TournamentEvent = z.infer<typeof TournamentEventSchema>;

/**
 * A replay frame event: the public {@link TableEvent} plus the hash-chain
 * provenance columns persisted alongside it and the accepted-action
 * correlation (turn/request/action) recorded with the event. The correlation
 * fields are null for events that are not accepted table actions.
 */
export const ReplayFrameEventSchema = TableEventSchema.extend({
  previousHash: z.string().min(1).nullable(),
  hash: z.string().min(1),
  turnId: IdSchema.nullable().optional(),
  requestId: IdSchema.nullable().optional(),
  actionId: IdSchema.nullable().optional(),
});
export type ReplayFrameEvent = z.infer<typeof ReplayFrameEventSchema>;

/** True when the sequence numbers are strictly contiguous (`+1` steps). */
export function isContiguousEventSeq(events: ReadonlyArray<{ eventSeq: number }>): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i].eventSeq !== events[i - 1].eventSeq + 1) return false;
  }
  return true;
}

/** Request an ordered replay slice from the append-only event log. */
export const ReplayRequestSchema = z
  .strictObject({
    tableId: TableIdSchema,
    fromEventSeq: CounterSchema,
    toEventSeq: CounterSchema.optional(),
    includeState: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    if (request.toEventSeq !== undefined && request.toEventSeq < request.fromEventSeq) {
      ctx.addIssue({
        code: "custom",
        path: ["toEventSeq"],
        message: "toEventSeq must not precede fromEventSeq",
      });
    }
  });
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

/**
 * A single contiguous replay frame: strictly ordered, hash-linked events plus
 * practical provenance.
 *
 * - `anchorHash` is the persisted `hash` of the record immediately *before*
 *   `fromEventSeq` (null when the frame starts at genesis). It lets a client or
 *   operator verify a slice that does not start at event 1.
 * - `headEventSeq` is the authoritative `Table.eventSeq` at read time: the
 *   final bound of the log.
 * - `chainValid` is true only when every event's hash recomputes from its
 *   payload/linkage, the sequence is strictly contiguous, and the slice reaches
 *   its requested end. It must never be reported true when the last requested
 *   event is missing or truncated.
 * - `tournamentEvents` carries the associated durable tournament transitions /
 *   settlement references for a tournament table, in their own ordering.
 */
export const ReplayFrameSchema = z
  .strictObject({
    tableId: TableIdSchema,
    fromEventSeq: CounterSchema,
    toEventSeq: CounterSchema,
    anchorHash: z.string().min(1).nullable(),
    headEventSeq: CounterSchema,
    events: z.array(ReplayFrameEventSchema),
    chainValid: z.boolean(),
    tournamentEvents: z.array(TournamentEventSchema).optional(),
    state: PublicWireStateSchema.optional(),
  })
  .superRefine((frame, ctx) => {
    if (frame.toEventSeq < frame.fromEventSeq && frame.events.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["toEventSeq"],
        message: "toEventSeq must not precede fromEventSeq",
      });
    }
    if (!isAppendOnlyEventStream(frame.events)) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "events must be strictly ordered by eventSeq",
      });
    }
    if (!isContiguousEventSeq(frame.events)) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "events must be contiguous (no missing or reordered eventSeq)",
      });
    }
    if (frame.events.length > 0) {
      if (frame.events[0].eventSeq !== frame.fromEventSeq) {
        ctx.addIssue({
          code: "custom",
          path: ["events", 0, "eventSeq"],
          message: "first event must equal fromEventSeq",
        });
      }
      let prevHash = frame.anchorHash;
      for (let i = 0; i < frame.events.length; i++) {
        const event = frame.events[i];
        if (event.tableId !== frame.tableId) {
          ctx.addIssue({
            code: "custom",
            path: ["events", i, "tableId"],
            message: "event tableId must match the frame",
          });
        }
        if (event.previousHash !== prevHash) {
          ctx.addIssue({
            code: "custom",
            path: ["events", i, "previousHash"],
            message: "event previousHash does not link to the prior hash",
          });
        }
        prevHash = event.hash;
      }
    } else if (frame.chainValid && frame.fromEventSeq <= frame.headEventSeq) {
      ctx.addIssue({
        code: "custom",
        path: ["chainValid"],
        message: "an empty frame within the log cannot claim a valid chain",
      });
    }
    if (frame.chainValid) {
      if (!isAppendOnlyEventStream(frame.events) || !isContiguousEventSeq(frame.events)) {
        ctx.addIssue({
          code: "custom",
          path: ["chainValid"],
          message: "a non-contiguous frame cannot claim a valid chain",
        });
      }
      if (
        frame.events.length > 0 &&
        frame.events[frame.events.length - 1].eventSeq !== frame.toEventSeq
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["chainValid"],
          message: "a chain missing its last requested event is not valid",
        });
      }
    }
  });
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;
