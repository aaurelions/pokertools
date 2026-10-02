import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { Redis } from "ioredis";
import type { ObservationMessage, SeatObservation } from "@pokertools/types";

/**
 * Extended WebSocket with userId property
 */
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
}

/**
 * Revalidates the joined principal immediately before a private observation is
 * delivered. Captured from the WS route's join authorization path.
 */
export type AuthorizeObservationSend = () => Promise<boolean>;

interface TableSubscription {
  socket: WebSocket;
  userId: string;
  authorizeSend: AuthorizeObservationSend;
  lastObservation?: SeatObservation;
}

/**
 * Socket Manager - WebSocket connection multiplexing
 *
 * Uses a single Redis subscriber to prevent connection exhaustion. A pub/sub
 * notification is only a trigger: the manager re-fetches the latest canonical
 * observation per authenticated subscribed principal and sends a full
 * `OBSERVATION`. It never forwards a version-only notification or a cached
 * stale projection.
 */
export class SocketManager {
  private subscriber: Redis;
  private tableSubscriptions = new Map<string, Set<TableSubscription>>();
  /** Per-table serialization so concurrent notifications cannot interleave. */
  private sendQueues = new Map<string, Promise<void>>();

  constructor(private app: FastifyInstance) {
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

  /**
   * Log Redis failures without serializing the raw error object, which can
   * embed a credentialed connection URL.
   */
  private logRedisError(_error: unknown, message: string): void {
    this.app.log.error({ code: "REDIS_UNAVAILABLE" }, message);
  }

  private initSubscriber() {
    // Pattern: pubsub:table:{tableId}
    void this.subscriber.psubscribe("pubsub:table:*").catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
        this.logRedisError(error, "Redis subscriber error");
      }
    });

    this.subscriber.on("error", (error) => {
      if (!error.message.includes("Connection is closed")) {
        this.logRedisError(error, "Redis subscriber error");
      }
    });

    this.subscriber.on("pmessage", (_pattern, channel, message) => {
      const tableId = channel.split(":")[2];
      if (!tableId) return;

      // The payload is only a trigger. It is never trusted or forwarded.
      try {
        JSON.parse(message);
      } catch {
        this.app.log.warn({ tableId }, "Invalid table pub/sub message");
        return;
      }

      this.enqueue(tableId, () => this.broadcastObservation(tableId));
    });
  }

  private enqueue(tableId: string, task: () => Promise<void>): void {
    const previous = this.sendQueues.get(tableId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.sendQueues.set(tableId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.sendQueues.get(tableId) === next) {
          this.sendQueues.delete(tableId);
        }
      });
  }

  private isStaleObservation(current: SeatObservation, candidate: SeatObservation): boolean {
    if (candidate.eventSeq < current.eventSeq) return true;
    if (candidate.version !== current.version)
      return candidate.version < current.version || candidate.eventSeq === current.eventSeq;
    return candidate.eventSeq <= current.eventSeq;
  }

  private removeSubscription(tableId: string, subscription: TableSubscription): void {
    const sockets = this.tableSubscriptions.get(tableId);
    if (!sockets) return;
    sockets.delete(subscription);
    if (sockets.size === 0) {
      this.tableSubscriptions.delete(tableId);
    }
  }

  private async broadcastObservation(tableId: string): Promise<void> {
    const subscriptions = this.tableSubscriptions.get(tableId);
    if (!subscriptions || subscriptions.size === 0) return;

    // Snapshot the set: handling a send may mutate the subscription set.
    for (const subscription of [...subscriptions]) {
      const { socket, userId, authorizeSend } = subscription;

      if (socket.readyState !== WebSocket.OPEN) {
        this.removeSubscription(tableId, subscription);
        continue;
      }

      let authorized: boolean;
      try {
        authorized = await authorizeSend();
      } catch {
        authorized = false;
      }

      if (!authorized) {
        // Revoked/restricted credential: stop private delivery and detach
        // before any observation is sent.
        this.removeSubscription(tableId, subscription);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(4001, "Unauthorized");
        }
        continue;
      }

      let observation: SeatObservation;
      try {
        observation = await this.app.gameManager.getObservation(tableId, userId);
      } catch {
        // State unavailable/table closed: skip rather than send stale state.
        continue;
      }

      if (
        subscription.lastObservation &&
        this.isStaleObservation(subscription.lastObservation, observation)
      ) {
        continue;
      }

      // The subscription may have been left/replaced while awaiting.
      if (!this.tableSubscriptions.get(tableId)?.has(subscription)) {
        continue;
      }
      subscription.lastObservation = observation;

      if (socket.readyState !== WebSocket.OPEN) {
        this.removeSubscription(tableId, subscription);
        continue;
      }

      const message: ObservationMessage = {
        type: "OBSERVATION",
        tableId,
        observation,
        timestamp: Date.now(),
      };
      socket.send(JSON.stringify(message));
    }
  }

  joinTable(
    tableId: string,
    socket: WebSocket,
    userId: string,
    authorizeSend: AuthorizeObservationSend
  ) {
    (socket as AuthenticatedWebSocket).userId = userId;

    if (!this.tableSubscriptions.has(tableId)) {
      this.tableSubscriptions.set(tableId, new Set());
    }
    const subscriptions = this.tableSubscriptions.get(tableId)!;

    // Replace any prior subscription for this socket/table (e.g. rejoin).
    for (const existing of subscriptions) {
      if (existing.socket === socket) {
        subscriptions.delete(existing);
      }
    }

    subscriptions.add({ socket, userId, authorizeSend });
  }

  leaveTable(tableId: string, socket: WebSocket) {
    const sockets = this.tableSubscriptions.get(tableId);
    if (!sockets) return;
    for (const subscription of sockets) {
      if (subscription.socket === socket) {
        sockets.delete(subscription);
      }
    }
    if (sockets.size === 0) {
      this.tableSubscriptions.delete(tableId);
    }
  }
}
