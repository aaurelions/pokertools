/**
 * SDK-specific types and configuration
 *
 * Wire DTOs for auth, canonical table turns and finance live in
 * `@pokertools/types` and are re-exported from the SDK. Only SDK
 * configuration, transport events and view helpers are declared here.
 */

/**
 * SDK configuration options
 */
export interface PokerSDKConfig {
  /** Base URL of the PokerTools API (e.g., "https://api.poker.example.com") */
  baseUrl: string;

  /** WebSocket URL (defaults to baseUrl with ws:// protocol) */
  wsUrl?: string;

  /**
   * Credential for authentication. Wallet sessions and scoped SERVICE
   * credentials are both opaque bearer tokens: HTTP sends
   * `Authorization: Bearer <token>` and WebSocket sends `jwt.<token>`.
   */
  token?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Retry configuration */
  retry?: {
    /** Number of retries for failed requests (default: 3) */
    count?: number;
    /** Delay between retries in ms (default: 1000) */
    delay?: number;
    /** Exponential backoff multiplier (default: 2) */
    backoff?: number;
  };

  /** Custom fetch implementation (for React Native or custom environments) */
  fetch?: typeof fetch;

  /** Custom WebSocket implementation (for React Native or Node.js) */
  WebSocket?: typeof WebSocket;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * User-facing wire DTOs (`GET /user/me`, `/user/history`, `/notes`) are defined
 * once as strict runtime schemas in `@pokertools/types` and re-exported here so
 * existing SDK/React import paths keep working without duplicate declarations.
 */
export type { UserBalances, UserProfile, HandHistoryEntry, PlayerNote } from "@pokertools/types";

/**
 * SDK error class
 */
export class PokerSDKError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PokerSDKError";
  }
}

/**
 * WebSocket connection state
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Event emitter types
 */
export interface PokerSocketEvents {
  connect: () => void;
  disconnect: (reason?: string) => void;
  reconnect: (attempt: number) => void;
  error: (error: Error) => void;
  /** Full canonical observation for the joined table (auth-scoped). */
  observation: (tableId: string, observation: import("@pokertools/types").SeatObservation) => void;
  /** Canonical wire state on the first observation after join (ergonomic view). */
  snapshot: (tableId: string, state: import("@pokertools/types").PublicWireState) => void;
  /** Canonical wire state after a change (ergonomic view). */
  stateUpdate: (tableId: string, state: import("@pokertools/types").PublicWireState) => void;
  action: (tableId: string, playerId: string, actionType: string, amount?: number) => void;
}

/**
 * Type-safe event listener
 */
export type EventListener<T extends keyof PokerSocketEvents> = PokerSocketEvents[T];
