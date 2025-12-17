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

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { token?: string } }>(
    "/play",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const token = request.query.token || request.cookies.token;

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
        if (!session || session.revoked) throw new Error("Session revoked");
      } catch {
        socket.close(4001, "Unauthorized");
        return;
      }

      const subscriptions = new Set<string>();

      /**
       * Helper to send typed messages to client
       */
      const sendMessage = (msg: ServerMessage) => {
        socket.send(JSON.stringify(msg));
      };

      // Setup heartbeat/ping-pong mechanism to detect dead connections
      let isAlive = true;
      const heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          // Client didn't respond to ping, terminate connection
          clearInterval(heartbeatInterval);
          socket.terminate();
          return;
        }

        // Mark as not alive and send ping
        isAlive = false;
        socket.ping();
      }, 30000); // Ping every 30 seconds

      socket.on("pong", () => {
        // Client responded, mark as alive
        isAlive = true;
      });

      socket.on("message", async (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          const result = safeParseClientMessage(parsed);

          if (!result.success) {
            const errorMsg: ErrorMessage = {
              type: "ERROR",
              code: "INVALID_MESSAGE",
              message: "Invalid message format",
              context: { errors: result.error.errors },
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
      });

      socket.on("close", () => {
        clearInterval(heartbeatInterval);
        for (const tableId of subscriptions) {
          fastify.socketManager.leaveTable(tableId, socket);
        }
        subscriptions.clear();
      });
    }
  );
};
