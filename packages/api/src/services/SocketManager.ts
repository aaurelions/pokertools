import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Redis } from "ioredis";
import { PokerEngine } from "@pokertools/engine";

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
      await this.subscriber.quit();
    });
  }

  private initSubscriber() {
    // Pattern: pubsub:table:{tableId}
    void this.subscriber.psubscribe("pubsub:table:*");

    this.subscriber.on("pmessage", async (_pattern, channel, _message) => {
      const tableId = channel.split(":")[2];
      if (!tableId) return;

      const sockets = this.tableSubscriptions.get(tableId);
      if (!sockets || sockets.size === 0) return;

      try {
        // Fetch state ONCE per update
        const rawState = await this.app.redis.get(`table:${tableId}`);
        if (!rawState) return;

        const snapshot = JSON.parse(rawState);
        const engine = PokerEngine.restore(snapshot);

        // Broadcast masked views to each socket
        for (const socket of sockets) {
          if (socket.readyState === 1) {
            // OPEN
            const userId = socket.userId;

            // Engine handles masking
            const maskedView = engine.view(userId);

            socket.send(
              JSON.stringify({
                type: "STATE_UPDATE",
                tableId,
                state: maskedView,
              })
            );
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
