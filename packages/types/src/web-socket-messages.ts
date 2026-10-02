import { z } from "zod";
import { SeatObservationSchema, type SeatObservation } from "./canonical";

/**
 * WebSocket Protocol Definitions
 *
 * The live private stream is canonical: after `JOIN`, the server sends a full
 * `OBSERVATION` (the authoritative per-seat decision boundary) and re-sends a
 * full `OBSERVATION` whenever the underlying state changes. There is no
 * notification-only `STATE_UPDATE` frame on the wire; clients never advance a
 * cached version without a fresh full projection.
 *
 * All server messages are validated against strict runtime schemas. Client
 * messages (`JOIN`/`LEAVE`/`PING`) are strict as well.
 */

// ============================================================================
// Client -> Server Messages (Upstream)
// ============================================================================

/**
 * Join a table's real-time updates
 */
export interface JoinTableMessage {
  readonly type: "JOIN";
  readonly tableId: string;
  readonly requestId?: string;
}

/** Leave a table's real-time updates. */
export interface LeaveTableMessage {
  readonly type: "LEAVE";
  readonly tableId: string;
  readonly requestId?: string;
}

/**
 * Application-level heartbeat (in addition to WebSocket ping/pong)
 * Useful for detecting issues at application layer
 */
export interface PingMessage {
  readonly type: "PING";
  readonly requestId: string;
  readonly timestamp?: number;
}

/**
 * Union of all client-to-server messages
 */
export type ClientMessage = JoinTableMessage | LeaveTableMessage | PingMessage;

// ============================================================================
// Server -> Client Messages (Downstream)
// ============================================================================

/**
 * Full canonical observation for the authenticated principal.
 *
 * Sent on join and on every state change. `requestId` echoes the joining
 * request when the observation is the direct JOIN response.
 */
export interface ObservationMessage {
  readonly type: "OBSERVATION";
  readonly tableId: string;
  readonly observation: SeatObservation;
  readonly timestamp: number;
  readonly requestId?: string;
}

/**
 * Error message
 */
export interface ErrorMessage {
  readonly type: "ERROR";
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  /** Additional error context. */
  readonly context?: Record<string, unknown>;
}

/**
 * Acknowledgment of successful operation
 */
export interface AckMessage {
  readonly type: "ACK";
  readonly requestId: string;
  readonly message?: string;
}

/**
 * Pong response to client PING
 */
export interface PongMessage {
  readonly type: "PONG";
  readonly requestId: string;
  readonly timestamp: number; // Server timestamp
}

/**
 * Player action notification (informational only)
 * Not required for state sync, but useful for animations/UX
 */
export interface ActionNotificationMessage {
  readonly type: "ACTION";
  readonly tableId: string;
  readonly playerId: string;
  readonly actionType: string;
  readonly amount?: number;
  readonly timestamp: number;
}

/**
 * Union of all server-to-client messages
 */
export type ServerMessage =
  ObservationMessage | ErrorMessage | AckMessage | PongMessage | ActionNotificationMessage;

// ============================================================================
// Type Guards
// ============================================================================

export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const { type } = msg as { type?: string };
  return type === "JOIN" || type === "LEAVE" || type === "PING";
}

export function isJoinMessage(msg: ClientMessage): msg is JoinTableMessage {
  return msg.type === "JOIN";
}

export function isLeaveMessage(msg: ClientMessage): msg is LeaveTableMessage {
  return msg.type === "LEAVE";
}

export function isPingMessage(msg: ClientMessage): msg is PingMessage {
  return msg.type === "PING";
}

export function isServerMessage(msg: unknown): msg is ServerMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const { type } = msg as { type?: string };
  return (
    type === "OBSERVATION" ||
    type === "ERROR" ||
    type === "ACK" ||
    type === "PONG" ||
    type === "ACTION"
  );
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

export const JoinTableMessageSchema = z.strictObject({
  type: z.literal("JOIN"),
  tableId: z.string().min(1),
  requestId: z.string().optional(),
});

export const LeaveTableMessageSchema = z.strictObject({
  type: z.literal("LEAVE"),
  tableId: z.string().min(1),
  requestId: z.string().optional(),
});

export const PingMessageSchema = z.strictObject({
  type: z.literal("PING"),
  requestId: z.string().min(1),
  timestamp: z.number().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinTableMessageSchema,
  LeaveTableMessageSchema,
  PingMessageSchema,
]);

/**
 * Utility to parse and validate a client message
 */
export function parseClientMessage(data: unknown): ClientMessage {
  return ClientMessageSchema.parse(data);
}

/**
 * Safe parser that returns result object instead of throwing
 */
export function safeParseClientMessage(
  data: unknown
): { success: true; data: ClientMessage } | { success: false; error: z.ZodError } {
  const result = ClientMessageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// Server Message Zod Schemas
// ============================================================================

export const ObservationMessageSchema = z.strictObject({
  type: z.literal("OBSERVATION"),
  tableId: z.string().min(1),
  observation: SeatObservationSchema,
  timestamp: z.number(),
  requestId: z.string().optional(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("ERROR"),
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const AckMessageSchema = z.object({
  type: z.literal("ACK"),
  requestId: z.string(),
  message: z.string().optional(),
});

export const PongMessageSchema = z.object({
  type: z.literal("PONG"),
  requestId: z.string(),
  timestamp: z.number(),
});

export const ActionNotificationMessageSchema = z.object({
  type: z.literal("ACTION"),
  tableId: z.string().min(1),
  playerId: z.string(),
  actionType: z.string(),
  amount: z.number().optional(),
  timestamp: z.number(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ObservationMessageSchema,
  ErrorMessageSchema,
  AckMessageSchema,
  PongMessageSchema,
  ActionNotificationMessageSchema,
]);

/**
 * Parse and validate a server message (throws on invalid)
 */
export function parseServerMessage(data: unknown): ServerMessage {
  return ServerMessageSchema.parse(data);
}

/**
 * Safe parser for server messages
 */
export function safeParseServerMessage(
  data: unknown
): { success: true; data: ServerMessage } | { success: false; error: z.ZodError } {
  const result = ServerMessageSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
