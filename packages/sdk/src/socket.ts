/**
 * PokerSocket - WebSocket client for real-time game updates
 *
 * Provides automatic reconnection, heartbeat, and typed event handling for the
 * canonical live stream: the server sends full `OBSERVATION` messages (the
 * authoritative per-seat decision boundary) on join and on every change. The
 * client never invents a newer version from a notification; ordering is
 * enforced with `version` + `eventSeq`.
 */

import type {
  ClientMessage,
  JoinTableMessage,
  LeaveTableMessage,
  PingMessage,
  SeatObservation,
  PublicWireState,
} from "@pokertools/types";

import { safeParseServerMessage } from "@pokertools/types";

import {
  PokerSDKConfig,
  PokerSDKError,
  ConnectionState,
  PokerSocketEvents,
  EventListener,
} from "./types";

/**
 * WebSocket configuration
 */
interface SocketConfig {
  /** WebSocket URL */
  url: string;
  /** JWT token for authentication. Sent as a WebSocket subprotocol, never in the URL. */
  token: string;
  /** Heartbeat interval in ms (default: 25000) */
  heartbeatInterval?: number;
  /** Reconnection attempts (default: 10) */
  reconnectAttempts?: number;
  /** Base reconnection delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Max reconnection delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Custom WebSocket implementation */
  WebSocket?: typeof WebSocket;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Default socket configuration
 */
const DEFAULT_SOCKET_CONFIG = {
  heartbeatInterval: 25000,
  reconnectAttempts: 10,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
};

/**
 * PokerSocket - Real-time WebSocket client
 *
 * @example
 * ```typescript
 * const socket = new PokerSocket({
 *   url: "wss://api.poker.example.com/ws/play",
 *   token: "jwt-token",
 * });
 *
 * socket.on("observation", (tableId, observation) => {
 *   console.log("Observation version:", observation.version, observation.eventSeq);
 * });
 *
 * await socket.connect();
 * const observation = await socket.join("table-123");
 *
 * // Later: disconnect
 * socket.disconnect();
 * ```
 */
export class PokerSocket {
  private readonly url: string;
  private readonly token: string;
  private readonly protocolToken: string;
  private readonly heartbeatInterval: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly debug: boolean;

  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = "disconnected";
  private reconnectCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private joinedTables = new Set<string>();
  private listeners = new Map<
    keyof PokerSocketEvents,
    Set<EventListener<keyof PokerSocketEvents>>
  >();
  private shouldReconnect = true;
  private rejectConnection: ((error: Error) => void) | null = null;

  // Latest canonical observation for each table. The full projection is the
  // only source of client state; there is no version-only cache.
  private observationCache = new Map<string, SeatObservation>();

  constructor(config: SocketConfig) {
    // Keep authentication material out of URLs so it is not captured by
    // access logs, proxy logs, or browser history.
    const wsUrl = new URL(config.url);
    this.url = wsUrl.toString();
    this.token = config.token;
    this.protocolToken = `jwt.${config.token}`;

    this.heartbeatInterval = config.heartbeatInterval ?? DEFAULT_SOCKET_CONFIG.heartbeatInterval;
    this.reconnectAttempts = config.reconnectAttempts ?? DEFAULT_SOCKET_CONFIG.reconnectAttempts;
    this.reconnectDelay = config.reconnectDelay ?? DEFAULT_SOCKET_CONFIG.reconnectDelay;
    this.maxReconnectDelay = config.maxReconnectDelay ?? DEFAULT_SOCKET_CONFIG.maxReconnectDelay;
    this.WebSocketImpl = config.WebSocket ?? globalThis.WebSocket;
    this.debug = config.debug ?? false;
  }

  /**
   * Create a PokerSocket from SDK config
   */
  static fromConfig(config: PokerSDKConfig): PokerSocket {
    if (!config.token) {
      throw new PokerSDKError("Token is required for WebSocket connection", "AUTH_REQUIRED");
    }

    const baseUrl = config.baseUrl.replace(/\/$/, "");
    const wsUrl = config.wsUrl ?? baseUrl.replace(/^http/, "ws") + "/ws/play";

    return new PokerSocket({
      url: wsUrl,
      token: config.token,
      WebSocket: config.WebSocket,
      debug: config.debug,
    });
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to the WebSocket server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionState === "connected") {
        resolve();
        return;
      }

      if (this.connectionState === "connecting") {
        // Wait for existing connection attempt
        const checkConnection = () => {
          if (this.connectionState === "connected") {
            resolve();
          } else if (this.connectionState === "disconnected") {
            reject(new PokerSDKError("Connection failed", "CONNECTION_FAILED"));
          } else {
            setTimeout(checkConnection, 100);
          }
        };
        checkConnection();
        return;
      }

      this.shouldReconnect = true;
      this.connectionState = "connecting";
      this.rejectConnection = reject;
      this.log("Connecting to", this.url);

      try {
        const ws = new this.WebSocketImpl(this.url, ["pokertools", this.protocolToken]);
        this.ws = ws;

        ws.onopen = () => {
          if (this.ws !== ws) return;
          this.rejectConnection = null;
          this.connectionState = "connected";
          this.reconnectCount = 0;
          this.startHeartbeat();
          this.emit("connect");
          this.log("Connected");

          // Rejoin previously joined tables
          void this.rejoinTables();

          resolve();
        };

        ws.onclose = (event) => {
          // A closing socket from a previous connection must not destroy the
          // replacement connection or deliver another principal's old state.
          if (this.ws !== ws) return;
          this.rejectConnection?.(new PokerSDKError("Connection closed", "CONNECTION_CLOSED"));
          this.rejectConnection = null;
          this.handleDisconnect(event.reason || "Connection closed");
        };

        ws.onerror = (event) => {
          if (this.ws !== ws) return;
          this.log("WebSocket error:", event);
          if (this.connectionState === "connecting") {
            reject(new PokerSDKError("Connection failed", "CONNECTION_FAILED"));
          }
        };

        ws.onmessage = (event) => {
          if (this.ws !== ws) return;
          this.handleMessage(event.data as string);
        };
      } catch (error) {
        this.connectionState = "disconnected";
        this.rejectConnection = null;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearPendingRequests("Connection closed");
    this.observationCache.clear();
    this.rejectConnection?.(new PokerSDKError("Connection closed", "CONNECTION_CLOSED"));
    this.rejectConnection = null;

    if (this.ws) {
      const closingSocket = this.ws;
      this.ws = null;
      closingSocket.close(1000, "Client disconnect");
    }

    this.connectionState = "disconnected";
    this.emit("disconnect", "Client disconnect");
    this.log("Disconnected");
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === "connected";
  }

  // ============================================================================
  // Table Subscription
  // ============================================================================

  /**
   * Join a table and resolve with its first canonical observation.
   */
  async join(tableId: string): Promise<SeatObservation> {
    if (this.connectionState !== "connected") {
      throw new PokerSDKError("Not connected", "NOT_CONNECTED");
    }

    const requestId = this.generateRequestId();
    const message: JoinTableMessage = {
      type: "JOIN",
      tableId,
      requestId,
    };

    this.joinedTables.add(tableId);
    this.send(message);

    // Wait for the first OBSERVATION for this table
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(`observation:${tableId}`);
        reject(new PokerSDKError("Join timeout", "TIMEOUT"));
      }, 10000);

      this.pendingRequests.set(`observation:${tableId}`, {
        resolve: (observation) => {
          clearTimeout(timeout);
          resolve(observation as SeatObservation);
        },
        reject,
        timeout,
      });
    });
  }

  /**
   * Leave a table
   */
  leave(tableId: string): void {
    if (this.connectionState !== "connected") {
      return;
    }

    this.joinedTables.delete(tableId);
    this.observationCache.delete(tableId);

    const message: LeaveTableMessage = {
      type: "LEAVE",
      tableId,
    };

    this.send(message);
  }

  /**
   * Get currently joined tables
   */
  getJoinedTables(): string[] {
    return Array.from(this.joinedTables);
  }

  /**
   * Get the latest canonical observation for a table.
   */
  getCachedObservation(tableId: string): SeatObservation | undefined {
    return this.observationCache.get(tableId);
  }

  /**
   * Get the latest canonical wire state for a table (ergonomic view).
   * This is always the state of a full observation, never a version-only stub.
   */
  getCachedState(tableId: string): PublicWireState | undefined {
    return this.observationCache.get(tableId)?.state;
  }

  /**
   * Get latest known version for a table.
   * Returns undefined if no observation has been received.
   */
  getTableVersion(tableId: string): number | undefined {
    return this.observationCache.get(tableId)?.version;
  }

  /**
   * Get latest known event sequence for a table.
   * Returns undefined if no observation has been received.
   */
  getTableEventSeq(tableId: string): number | undefined {
    return this.observationCache.get(tableId)?.eventSeq;
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Subscribe to an event
   */
  on<E extends keyof PokerSocketEvents>(event: E, listener: PokerSocketEvents[E]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);

    // Return unsubscribe function
    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Unsubscribe from an event
   */
  off<E extends keyof PokerSocketEvents>(event: E, listener: PokerSocketEvents[E]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Subscribe to an event (once)
   */
  once<E extends keyof PokerSocketEvents>(event: E, listener: PokerSocketEvents[E]): () => void {
    const onceWrapper = ((...args: Parameters<PokerSocketEvents[E]>) => {
      this.off(event, onceWrapper);
      (listener as (...args: unknown[]) => void)(...args);
    }) as PokerSocketEvents[E];

    return this.on(event, onceWrapper);
  }

  // ============================================================================
  // Ping
  // ============================================================================

  /**
   * Send application-level ping (not WebSocket ping)
   */
  async ping(): Promise<number> {
    if (this.connectionState !== "connected") {
      throw new PokerSDKError("Not connected", "NOT_CONNECTED");
    }

    const requestId = this.generateRequestId();
    const startTime = Date.now();

    const message: PingMessage = {
      type: "PING",
      requestId,
      timestamp: startTime,
    };

    this.send(message);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new PokerSDKError("Ping timeout", "TIMEOUT"));
      }, 5000);

      this.pendingRequests.set(requestId, {
        resolve: () => {
          resolve(Date.now() - startTime);
        },
        reject,
        timeout,
      });
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Send a message to the server
   */
  private send(message: ClientMessage): void {
    if (this.ws?.readyState !== this.WebSocketImpl.OPEN) {
      throw new PokerSDKError("WebSocket not open", "NOT_CONNECTED");
    }

    this.log("Sending:", message);
    this.ws.send(JSON.stringify(message));
  }

  /**
   * True when `candidate` is not newer than `current` by (version, eventSeq).
   * Used to drop reordered or duplicated observations.
   */
  private isStaleObservation(current: SeatObservation, candidate: SeatObservation): boolean {
    // Both counters are table-global PostgreSQL sequences. A different hand ID
    // must never permit a delayed observation to rewind either counter.
    if (candidate.eventSeq < current.eventSeq) return true;
    if (candidate.version !== current.version) {
      return candidate.version < current.version || candidate.eventSeq === current.eventSeq;
    }
    return candidate.eventSeq <= current.eventSeq;
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      const parsed: unknown = JSON.parse(data);
      const result = safeParseServerMessage(parsed);
      if (!result.success) {
        this.log("Invalid server message:", result.error);
        return;
      }
      const message = result.data;
      this.log("Received:", message);

      switch (message.type) {
        case "OBSERVATION": {
          const incoming = message.observation;
          const cached = this.observationCache.get(message.tableId);

          // Async notifications can reorder. Never regress to an older
          // (version, eventSeq) projection, and never advance a version
          // without the full projection that carries it.
          if (cached && this.isStaleObservation(cached, incoming)) {
            this.log("Ignoring stale observation:", message.tableId, incoming.version);
            break;
          }

          const isFirst = cached === undefined;
          this.observationCache.set(message.tableId, incoming);

          // Resolve a pending join with the first observation for the table
          const pending = this.pendingRequests.get(`observation:${message.tableId}`);
          if (pending) {
            this.pendingRequests.delete(`observation:${message.tableId}`);
            pending.resolve(incoming);
          }

          this.emit("observation", message.tableId, incoming);
          if (isFirst) {
            this.emit("snapshot", message.tableId, incoming.state);
          } else {
            this.emit("stateUpdate", message.tableId, incoming.state);
          }
          break;
        }

        case "ACTION": {
          this.emit(
            "action",
            message.tableId,
            message.playerId,
            message.actionType,
            message.amount
          );
          break;
        }

        case "ACK": {
          const pending = this.pendingRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(message.requestId);
            pending.resolve(undefined);
          }
          break;
        }

        case "PONG": {
          const pending = this.pendingRequests.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(message.requestId);
            pending.resolve(message.timestamp);
          }
          break;
        }

        case "ERROR": {
          this.log("Server error:", message);
          if (message.requestId) {
            const pending = this.pendingRequests.get(message.requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingRequests.delete(message.requestId);
              pending.reject(new PokerSDKError(message.message, message.code));
            }
          }
          this.emit("error", new PokerSDKError(message.message, message.code));
          break;
        }
      }
    } catch (error) {
      this.log("Failed to parse message:", error);
    }
  }

  /**
   * Handle disconnect
   */
  private handleDisconnect(reason: string): void {
    this.stopHeartbeat();
    this.clearPendingRequests("Connection closed");
    this.ws = null;

    const wasConnected = this.connectionState === "connected";
    this.connectionState = "disconnected";

    if (wasConnected) {
      this.emit("disconnect", reason);
    }

    // Attempt reconnection if enabled
    if (this.shouldReconnect && this.reconnectCount < this.reconnectAttempts) {
      void this.reconnect();
    }
  }

  /**
   * Attempt to reconnect
   */
  private async reconnect(): Promise<void> {
    this.reconnectCount++;
    this.connectionState = "reconnecting";

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectCount - 1),
      this.maxReconnectDelay
    );

    this.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${this.reconnectAttempts})`
    );
    this.emit("reconnect", this.reconnectCount);

    await this.sleep(delay);

    if (!this.shouldReconnect) {
      return;
    }

    try {
      await this.connect();
    } catch {
      // connect() handles its own errors
    }
  }

  /**
   * Rejoin previously joined tables
   */
  private async rejoinTables(): Promise<void> {
    for (const tableId of this.joinedTables) {
      try {
        await this.join(tableId);
      } catch (error) {
        this.log("Failed to rejoin table:", tableId, error);
      }
    }
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.connectionState === "connected") {
        void this.ping().catch(() => {
          // Ping failed, connection might be dead
          this.log("Heartbeat failed");
        });
      }
    }, this.heartbeatInterval);
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Clear all pending requests
   */
  private clearPendingRequests(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);

      pending.reject(new PokerSDKError(reason, "CONNECTION_CLOSED"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Emit event to listeners
   */
  private emit<E extends keyof PokerSocketEvents>(
    event: E,
    ...args: Parameters<PokerSocketEvents[E]>
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as (...args: unknown[]) => void)(...args);
        } catch (error) {
          this.log("Listener error:", error);
        }
      }
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Debug logger
   */
  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[PokerSocket]", ...args);
    }
  }
}
