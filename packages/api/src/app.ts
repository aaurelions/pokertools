import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

// Plugins
import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import redlockPlugin from "./plugins/redlock.js";
import queuePlugin from "./plugins/queue.js";
import servicesPlugin from "./plugins/services.js";

// Routes
import { authRoutes } from "./routes/auth/index.js";
import { tableRoutes } from "./routes/tables/index.js";
import { userRoutes } from "./routes/user/index.js";
import { wsRoutes } from "./routes/ws/index.js";
import { financeRoutes } from "./routes/finance/index.js";
import { notesRoutes } from "./routes/notes/index.js";

import { config } from "./config.js";

export async function buildApp() {
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false // Disable logging in tests
        : {
            level: config.LOG_LEVEL,
            transport:
              config.NODE_ENV === "development"
                ? {
                    target: "pino-pretty",
                    options: {
                      colorize: true,
                      translateTime: "HH:MM:ss Z",
                      ignore: "pid,hostname",
                    },
                  }
                : undefined,
          },
  });

  // Add custom serializer to handle BigInt values safely
  app.addHook("preSerialization", async (_request, _reply, payload: unknown) => {
    if (payload && typeof payload === "object") {
      // Safe: We're serializing and deserializing to handle BigInt
      const serialized = JSON.stringify(payload, (_, value) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        typeof value === "bigint" ? value.toString() : value
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return JSON.parse(serialized);
    }
    return payload;
  });

  // Security plugins
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Disable rate limiting in test environment
  if (config.NODE_ENV !== "test") {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
    });
  }

  // JWT
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: {
      cookieName: "token",
      signed: false,
    },
  });

  await app.register(cookie, {
    secret: config.COOKIE_SECRET,
  });

  // WebSocket
  await app.register(websocket);

  // Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: "@pokertools/api",
        version: "1.0.2",
        description: "🃏 PokerTools API",
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Infrastructure plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(redlockPlugin);
  await app.register(queuePlugin);
  await app.register(servicesPlugin);

  // Auth decorator
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      // Check session not revoked
      const { jti } = request.user;
      const session = await app.prisma.session.findUnique({ where: { jti } });
      if (session === null || session.revoked) {
        throw new Error("Session revoked");
      }
    } catch (_err) {
      await reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Routes
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(tableRoutes, { prefix: "/tables" });
  await app.register(userRoutes, { prefix: "/user" });
  await app.register(wsRoutes, { prefix: "/ws" });
  await app.register(financeRoutes, { prefix: "/finance" });
  await app.register(notesRoutes, { prefix: "/notes" });

  // Health check
  app.get("/health", () => {
    return { status: "ok", timestamp: Date.now() };
  });

  return app;
}
