import type { FastifyPluginAsync } from "fastify";
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

function tokenFromProtocolHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header.split(",").map((protocol) => protocol.trim());
  const bearer = protocols.find((protocol) => protocol.startsWith("jwt."));
  return bearer?.slice(4);
}

const MAX_CONNECTIONS_PER_USER = 4;
const MAX_PRE_AUTH_QUEUE = 8;
const MAX_BUFFERED_BYTES = 1_000_000;

const userConnectionCounts = new Map<string, number>();

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
        if (queuedMessages.length >= MAX_PRE_AUTH_QUEUE) {
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

    const existingConnections = userConnectionCounts.get(userId) ?? 0;
    if (existingConnections >= MAX_CONNECTIONS_PER_USER) {
      socket.close(1008, "Connection limit exceeded");
      return;
    }
    userConnectionCounts.set(userId, existingConnections + 1);

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
    }, 30000);

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

    socket.on("close", () => {
      clearInterval(heartbeatInterval);
      const currentCount = userConnectionCounts.get(userId) ?? 0;
      if (currentCount <= 1) {
        userConnectionCounts.delete(userId);
      } else {
        userConnectionCounts.set(userId, currentCount - 1);
      }
      for (const tableId of subscriptions) {
        fastify.socketManager.leaveTable(tableId, socket);
      }
      subscriptions.clear();
    });
  });
};
