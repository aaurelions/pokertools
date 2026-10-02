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
  type ObservationMessage,
} from "@pokertools/types";
import { config } from "../../config.js";
import type { AuthenticatedPrincipal } from "../../services/principal-manager.js";

function tokenFromProtocolHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header.split(",").map((protocol) => protocol.trim());
  const bearer = protocols.find((protocol) => protocol.startsWith("jwt."));
  return bearer?.slice(4);
}

const MAX_BUFFERED_BYTES = 1_000_000;

// Service credentials are revalidated on every message and periodically while
// idle so revocation stops private observation/live delivery on open sockets.
const SERVICE_REVALIDATE_INTERVAL_MS = 5_000;

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

    // -----------------------------------------------------------------------
    // Register a bounded queue before async auth so clients that send JOIN as
    // soon as the socket opens do not lose their first message, while malformed
    // clients cannot grow memory without limit during JWT/session validation.
    // -----------------------------------------------------------------------
    const queuedMessages: Buffer[] = [];
    let messageHandler: ((data: Buffer) => Promise<void>) | null = null;
    socket.on("message", (data: Buffer) => {
      if (messageHandler) {
        void messageHandler(data);
        return;
      }

      if (queuedMessages.length >= config.WS_MAX_PRE_AUTH_QUEUE) {
        socket.close(1008, "Pre-authentication message limit exceeded");
        return;
      }
      queuedMessages.push(data);
    });

    let principal: AuthenticatedPrincipal;
    let walletSessionJti: string | null = null;
    try {
      if (!token) throw new Error("No token");

      if (fastify.principalManager.isServiceToken(token)) {
        // Opaque service credential delivered via `jwt.<token>` subprotocol.
        const resolved = await fastify.principalManager.authenticateServiceToken(token);
        if (!resolved) throw new Error("Invalid service credential");
        principal = resolved;
      } else {
        const decoded = await fastify.jwt.verify<{
          userId: string;
          address?: string;
          jti: string;
        }>(token);
        walletSessionJti = decoded.jti;

        const session = await fastify.prisma.session.findUnique({
          where: { jti: decoded.jti },
          include: { user: { select: { id: true, address: true, role: true, kind: true } } },
        });
        if (!session || session.revoked || session.expiresAt <= new Date()) {
          throw new Error("Session invalid");
        }

        const walletPrincipal = fastify.principalManager.buildWalletPrincipal({
          id: session.user.id,
          address: session.user.address,
          role: session.user.role,
          kind: session.user.kind,
        });
        if (!walletPrincipal) throw new Error("Not a wallet principal");
        principal = walletPrincipal;
      }
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }
    const userId = principal.id;
    const isServiceConnection = principal.kind === "SERVICE";

    // Revalidate the credential on every message (and periodically while idle).
    // Initial handshake authentication alone is not sufficient: revocation must
    // stop delivery to an already-open private observation socket.
    const serviceCredentialStillValid = async (): Promise<boolean> => {
      if (!isServiceConnection || !token) return true;
      const resolved = await fastify.principalManager.authenticateServiceToken(token, {
        touch: false,
      });
      return resolved !== null && resolved.credentialId === principal.credentialId;
    };

    // Wallet sessions are also revalidated before any private observation is
    // delivered, so a revoked/expired session cannot keep receiving state.
    const walletSessionStillValid = async (): Promise<boolean> => {
      if (isServiceConnection || !walletSessionJti) return true;
      const session = await fastify.prisma.session.findUnique({
        where: { jti: walletSessionJti },
        select: { revoked: true, expiresAt: true },
      });
      return session !== null && !session.revoked && session.expiresAt > new Date();
    };

    const principalStillValid = async (): Promise<boolean> => {
      if (!(await serviceCredentialStillValid())) return false;
      return walletSessionStillValid();
    };

    // Enforce per-user concurrent connection limit
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

    // Idle service sockets are revalidated so a revocation cannot leave a live
    // private subscription open indefinitely.
    const serviceRevalidateInterval = isServiceConnection
      ? setInterval(() => {
          void serviceCredentialStillValid().then((valid) => {
            if (!valid) socket.close(4001, "Unauthorized");
          });
        }, SERVICE_REVALIDATE_INTERVAL_MS)
      : null;

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

      // Re-check service credential validity before processing any message.
      if (!(await serviceCredentialStillValid())) {
        socket.close(4001, "Unauthorized");
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

          // Seat restrictions are checked against the principal's authoritative
          // seat in engine state — never a client-supplied seat. Fail closed if
          // a seat-restricted credential's seat cannot be established.
          let persistedSeat: number | null = null;
          if (principal.restrictions.seat !== null) {
            const seatState = await fastify.gameManager.getState(tableId).catch(() => null);
            const index = seatState?.players.findIndex((player) => player?.id === userId) ?? -1;
            persistedSeat = index >= 0 ? index : null;
          }

          // Scope boundary first: a principal without table:observe (or bound
          // to another table/seat) receives no state, even as a spectator.
          const scopeAuthorization = fastify.principalManager.authorizeTable(
            principal,
            "table:observe",
            tableId,
            persistedSeat
          );
          if (!scopeAuthorization.allowed) {
            const errorMsg: ErrorMessage = {
              type: "ERROR",
              code: scopeAuthorization.reason,
              message: "Not authorized to observe this table",
              ...(requestId ? { requestId } : {}),
            };
            sendMessage(errorMsg);
            return;
          }

          const authorization = await canJoinTable(fastify, tableId, userId);
          if (!authorization.allowed) {
            const errorMsg: ErrorMessage = {
              type: "ERROR",
              code: authorization.reason,
              message:
                authorization.reason === "TABLE_NOT_FOUND"
                  ? "Table not found"
                  : "Not authorized to join this table",
              ...(requestId ? { requestId } : {}),
            };
            sendMessage(errorMsg);
            return;
          }

          subscriptions.add(tableId);

          // Per-send authorization is captured at join and re-run by the socket
          // manager before every private observation delivery. A revoked
          // credential, restriction or seat change stops delivery before send.
          const authorizeObservationSend = async (): Promise<boolean> => {
            if (!(await principalStillValid())) return false;
            const seatState = await fastify.gameManager.getState(tableId).catch(() => null);
            const index = seatState?.players.findIndex((player) => player?.id === userId) ?? -1;
            const currentSeat = index >= 0 ? index : null;
            return fastify.principalManager.authorizeTable(
              principal,
              "table:observe",
              tableId,
              currentSeat
            ).allowed;
          };

          fastify.socketManager.joinTable(tableId, socket, userId, authorizeObservationSend);

          // Send the initial full canonical observation produced by the masked
          // getObservation adapter. There is no partial/notification-only wire.
          const observation = await fastify.gameManager.getObservation(tableId, userId);
          const observationMessage: ObservationMessage = {
            type: "OBSERVATION",
            tableId,
            observation,
            timestamp: Date.now(),
            ...(requestId ? { requestId } : {}),
          };
          sendMessage(observationMessage);

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
      if (serviceRevalidateInterval) clearInterval(serviceRevalidateInterval);
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
