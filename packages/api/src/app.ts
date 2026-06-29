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

  // Serialize BigInt values as strings to avoid JSON serialization errors.
  app.addHook("preSerialization", async (_request, _reply, payload: unknown) => {
    if (payload && typeof payload === "object") {
      const serialized = JSON.stringify(payload, (_, value) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        typeof value === "bigint" ? value.toString() : value
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return JSON.parse(serialized);
    }
    return payload;
  });

  await app.register(helmet, {
    contentSecurityPolicy: config.NODE_ENV === "production" ? undefined : false,
  });

  await app.register(cors, {
    origin:
      config.NODE_ENV === "production" && config.CORS_ORIGIN
        ? config.CORS_ORIGIN
        : config.NODE_ENV === "production"
          ? false
          : true,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: config.NODE_ENV !== "test",
    max: 100,
    timeWindow: "1 minute",
  });

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

  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "@pokertools/api",
        version: "1.0.12",
        description: "🃏 PokerTools API",
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(redlockPlugin);
  await app.register(queuePlugin);
  await app.register(servicesPlugin);

  // Authenticate decorator: validates JWT AND DB session so server-side
  // revocation/expiry cannot be bypassed with a still-valid token.
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const { jti } = request.user;
      const session = await app.prisma.session.findUnique({ where: { jti } });
      if (session === null || session.revoked || session.expiresAt <= new Date()) {
        throw new Error("Session invalid");
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

  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = err.statusCode ? Number(err.statusCode) : 500;
    const code = typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
    if (code === "RISK_DENIED") {
      app.observabilityManager.increment("pokertools_risk_denials_total", {
        route: request.routeOptions.url ?? request.url,
      });
    }
    if (statusCode >= 500) request.log.error({ error: err }, "Unhandled request error");
    return reply.code(statusCode).send({ error: code, message: err.message });
  });

  app.get("/health", async (request, reply) => {
    const health = await app.observabilityManager.health();
    if (health.status === "down") return reply.code(503).send(health);
    if (health.status === "degraded") return reply.code(200).send(health);
    return health;
  });

  app.get("/metrics", async (request, reply) => {
    if (config.NODE_ENV === "production") {
      if (!config.METRICS_TOKEN) return reply.code(404).send({ error: "Not found" });
      const expected = `Bearer ${config.METRICS_TOKEN}`;
      if (request.headers.authorization !== expected) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }
    return reply.type("text/plain; version=0.0.4").send(app.observabilityManager.metrics());
  });

  return app;
}
