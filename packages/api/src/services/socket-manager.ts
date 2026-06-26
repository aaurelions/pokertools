import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Redis } from "ioredis";

/**
 * Extended WebSocket with userId property
 */
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
}

/**
 * Socket Manager - WebSocket connection multiplexing
 *
 * Uses a single Redis subscriber to prevent connection exhaustion.
 * Fetches state once per update and masks per user.
 */
export class SocketManager {
  private subscriber: Redis;
  private tableSubscriptions = new Map<string, Set<AuthenticatedWebSocket>>();

  constructor(private app: FastifyInstance) {
    // Single Redis subscriber for ALL tables
    this.subscriber = app.redis.duplicate();
    this.initSubscriber();

    app.addHook("onClose", async () => {
      if (this.subscriber.status !== "end") {
        await this.subscriber.quit().catch((error: unknown) => {
          if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
            throw error;
          }
        });
      }
    });
  }

  private initSubscriber() {
    // Pattern: pubsub:table:{tableId}
    void this.subscriber.psubscribe("pubsub:table:*").catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
        this.app.log.error(error, "Redis subscriber error");
      }
    });

    this.subscriber.on("error", (error) => {
      if (!error.message.includes("Connection is closed")) {
        this.app.log.error(error, "Redis subscriber error");
      }
    });

    this.subscriber.on("pmessage", async (_pattern, channel, message) => {
      const tableId = channel.split(":")[2];
      if (!tableId) return;

      const sockets = this.tableSubscriptions.get(tableId);
      if (!sockets || sockets.size === 0) return;

      try {
        // Parse the lightweight notification published via Redis
        let payload: { type: string; tableId: string; version: number; timestamp?: number };
        try {
          payload = JSON.parse(message);
        } catch {
          this.app.log.warn(`Invalid pub message for table ${tableId}`);
          return;
        }

        // Ensure timestamp is present (publishers should include it)
        const broadcastMessage = JSON.stringify({
          type: "STATE_UPDATE",
          tableId: payload.tableId || tableId,
          version: payload.version ?? 0,
          timestamp: payload.timestamp ?? Date.now(),
        });

        // Forward lightweight STATE_UPDATE to all subscribers
        for (const socket of sockets) {
          if (socket.readyState === 1) {
            // OPEN
            socket.send(broadcastMessage);
          }
        }
      } catch (err) {
        this.app.log.error(err, "Broadcasting error");
      }
    });
  }

  joinTable(tableId: string, socket: WebSocket, userId: string) {
    (socket as AuthenticatedWebSocket).userId = userId;

    if (!this.tableSubscriptions.has(tableId)) {
      this.tableSubscriptions.set(tableId, new Set());
    }
    this.tableSubscriptions.get(tableId)!.add(socket);
  }

  leaveTable(tableId: string, socket: WebSocket) {
    const sockets = this.tableSubscriptions.get(tableId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.tableSubscriptions.delete(tableId);
      }
    }
  }
}
