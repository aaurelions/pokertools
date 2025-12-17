import { PublicState } from "./PublicState";

/**
 * WebSocket Protocol Definitions
 *
 * This file defines the complete WebSocket message protocol for real-time
 * poker game communication. All messages are strongly typed discriminated unions.
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
  readonly requestId?: string; // Optional correlation ID
}

/**
 * Leave a table's real-time updates
 */
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
 * State snapshot sent when client joins a table
 * or when requested via REST API
 */
export interface SnapshotMessage {
  readonly type: "SNAPSHOT";
  readonly tableId: string;
  readonly state: PublicState;
  readonly timestamp: number; // Server timestamp
}

/**
 * Lightweight notification that state has changed
 * Client should fetch full state via REST if needed
 */
export interface StateUpdateMessage {
  readonly type: "STATE_UPDATE";
  readonly tableId: string;
  readonly version: number; // New state version
  readonly timestamp: number;
}

/**
 * Error message
 */
export interface ErrorMessage {
  readonly type: "ERROR";
  readonly code: string;
  readonly message: string;
  readonly requestId?: string; // Echo back request ID if available
  readonly context?: Record<string, unknown>; // Additional error context
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
  | SnapshotMessage
  | StateUpdateMessage
  | ErrorMessage
  | AckMessage
  | PongMessage
  | ActionNotificationMessage;

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
    type === "SNAPSHOT" ||
    type === "STATE_UPDATE" ||
    type === "ERROR" ||
    type === "ACK" ||
    type === "PONG" ||
    type === "ACTION"
  );
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

import { z } from "zod";

export const JoinTableMessageSchema = z.object({
  type: z.literal("JOIN"),
  tableId: z.string().min(1),
  requestId: z.string().optional(),
});

export const LeaveTableMessageSchema = z.object({
  type: z.literal("LEAVE"),
  tableId: z.string().min(1),
  requestId: z.string().optional(),
});

export const PingMessageSchema = z.object({
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
