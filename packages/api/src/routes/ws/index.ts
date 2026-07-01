import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import {
  safeParseClientMessage,
  isJoinMessage,
  isLeaveMessage,
  isPingMessage,
  type ServerMessage,
  type ErrorMessage,
  type AckMessage,
  type PongMessage,
  type SnapshotMessage,
} from "@pokertools/types";
import { config } from "../../config.js";

function tokenFromProtocolHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header.split(",").map((protocol) => protocol.trim());
  const bearer = protocols.find((protocol) => protocol.startsWith("jwt."));
  return bearer?.slice(4);
}

const MAX_BUFFERED_BYTES = 1_000_000;

async function canJoinTable(fastify: FastifyInstance, tableId: string, userId: string) {
  if (config.NODE_ENV === "test") return { allowed: true } as const;

  const table = await fastify.prisma.table.findUnique({
    where: { id: tableId },
    select: {
      config: true,
      tournamentId: true,
      tournament: { select: { id: true, creatorId: true } },
    },
  });

  if (!table) return { allowed: false, reason: "TABLE_NOT_FOUND" } as const;

  const tableConfig = table.config as { allowSpectators?: boolean };
  if (tableConfig.allowSpectators === true) return { allowed: true } as const;

  const user = await fastify.prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role === "ADMIN") return { allowed: true } as const;
  if (table.tournament?.creatorId === userId) return { allowed: true } as const;

  if (table.tournamentId) {
    const entry = await fastify.prisma.tournamentEntry.findFirst({
      where: { tournamentId: table.tournamentId, userId },
      select: { id: true },
    });
    if (entry) return { allowed: true } as const;
  }

  const state = await fastify.gameManager.getState(tableId);
  if (state.players.some((player) => player?.id === userId)) return { allowed: true } as const;

  return { allowed: false, reason: "JOIN_NOT_AUTHORIZED" } as const;
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/play", { websocket: true }, async (socket: WebSocket, request) => {
    const token =
      request.cookies.token || tokenFromProtocolHeader(request.headers["sec-websocket-protocol"]);

    const queuedMessages: Buffer[] = [];
    let messageHandler: ((data: Buffer) => Promise<void>) | null = null;
    socket.on("message", (data: Buffer) => {
      if (messageHandler) {
        void messageHandler(data);
      } else {
        if (queuedMessages.length >= config.WS_MAX_PRE_AUTH_QUEUE) {
          socket.close(1008, "Pre-authentication message limit exceeded");
          return;
        }
        queuedMessages.push(data);
      }
    });

    let userId: string;
    try {
      if (!token) throw new Error("No token");
      const decoded = await fastify.jwt.verify<{ userId: string; address: string; jti: string }>(
        token
      );
      userId = decoded.userId;

      // Check session not revoked
      const session = await fastify.prisma.session.findUnique({
        where: { jti: decoded.jti },
      });
      if (!session || session.revoked || session.expiresAt <= new Date()) {
        throw new Error("Session invalid");
      }
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    let connectionAccepted = false;
    const connCount = await fastify.redis.hincrby("ws:connections", userId, 1);
    if (connCount > config.WS_MAX_CONNECTIONS_PER_USER) {
      await fastify.redis.hincrby("ws:connections", userId, -1);
      socket.close(1008, "Connection limit exceeded");
      return;
    }
    connectionAccepted = true;

    const subscriptions = new Set<string>();

    /**
     * Helper to send typed messages to client
     */
    const sendMessage = (msg: ServerMessage) => {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1009, "WebSocket backpressure limit exceeded");
        return;
      }
      socket.send(JSON.stringify(msg));
    };

    // Setup heartbeat/ping-pong mechanism to detect dead connections
    let isAlive = true;
    const heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        clearInterval(heartbeatInterval);
        socket.terminate();
        return;
      }

      isAlive = false;
      socket.ping();
    }, config.WS_HEARTBEAT_INTERVAL_MS);

    socket.on("pong", () => {
      isAlive = true;
    });

    messageHandler = async (data: Buffer) => {
      if (data.length > 4096) {
        const errorMsg: ErrorMessage = {
          type: "ERROR",
          code: "MESSAGE_TOO_LARGE",
          message: "Message exceeds maximum size of 4KB",
        };
        sendMessage(errorMsg);
        return;
      }

      try {
        const parsed = JSON.parse(data.toString());
        const result = safeParseClientMessage(parsed);

        if (!result.success) {
          const errorMsg: ErrorMessage = {
            type: "ERROR",
            code: "INVALID_MESSAGE",
            message: "Invalid message format",
            context: { errors: result.error.issues },
          };
          sendMessage(errorMsg);
          return;
        }

        const message = result.data;

        if (isJoinMessage(message)) {
          const { tableId, requestId } = message;
          const authorization = await canJoinTable(fastify, tableId, userId);
          if (!authorization.allowed) {
            const errorMsg: ErrorMessage = {
              type: "ERROR",
              code: authorization.reason,
              message:
                authorization.reason === "TABLE_NOT_FOUND"
                  ? "Table not found"
                  : "Not authorized to join this table",
            };
            sendMessage(errorMsg);
            return;
          }

          subscriptions.add(tableId);
          fastify.socketManager.joinTable(tableId, socket, userId);

          // Send initial state snapshot
          const state = await fastify.gameManager.getState(tableId, userId);
          const snapshot: SnapshotMessage = {
            type: "SNAPSHOT",
            tableId,
            state,
            version: state.version,
            timestamp: Date.now(),
          };
          sendMessage(snapshot);

          // Send acknowledgment if request ID provided
          if (requestId) {
            const ack: AckMessage = {
              type: "ACK",
              requestId,
              message: "Joined table successfully",
            };
            sendMessage(ack);
          }
        } else if (isLeaveMessage(message)) {
          const { tableId, requestId } = message;
          subscriptions.delete(tableId);
          fastify.socketManager.leaveTable(tableId, socket);

          // Send acknowledgment if request ID provided
          if (requestId) {
            const ack: AckMessage = {
              type: "ACK",
              requestId,
              message: "Left table successfully",
            };
            sendMessage(ack);
          }
        } else if (isPingMessage(message)) {
          const { requestId } = message;
          const pong: PongMessage = {
            type: "PONG",
            requestId,
            timestamp: Date.now(),
          };
          sendMessage(pong);
        }
      } catch (err) {
        const errorMsg: ErrorMessage = {
          type: "ERROR",
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        };
        sendMessage(errorMsg);
      }
    };

    for (const queued of queuedMessages.splice(0)) {
      void messageHandler(queued);
    }

    socket.on("close", async () => {
      clearInterval(heartbeatInterval);
      if (connectionAccepted) {
        // Best-effort decrement; the Redis connection may already be closing
        // during shutdown, so swallow connection-closed errors.
        try {
          const currentCount = await fastify.redis.hincrby("ws:connections", userId, -1);
          if (currentCount <= 0) {
            await fastify.redis.hdel("ws:connections", userId);
          }
        } catch {
          // Connection closed during shutdown — nothing to do.
        }
      }
      for (const tableId of subscriptions) {
        fastify.socketManager.leaveTable(tableId, socket);
      }
      subscriptions.clear();
    });
  });
};
