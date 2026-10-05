import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

// Plugins
import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import redlockPlugin from "./plugins/redlock.js";
import queuePlugin from "./plugins/queue.js";
import servicesPlugin from "./plugins/services.js";
import testRoutesPlugin from "./plugins/test-routes.js";

// Routes
import { authRoutes } from "./routes/auth/index.js";
import { tableRoutes } from "./routes/tables/index.js";
import { userRoutes } from "./routes/user/index.js";
import { wsRoutes } from "./routes/ws/index.js";
import { financeRoutes } from "./routes/finance/index.js";
import { notesRoutes } from "./routes/notes/index.js";
import { tournamentRoutes } from "./routes/tournaments/index.js";
import { chipRoutes } from "./routes/chips/index.js";
import { competitionRoutes } from "./routes/competitions/index.js";

import { config } from "./config.js";
import {
  parseTrustedProxyCidrs,
  registerRateLimiting,
  type RateLimitingOptions,
} from "./rate-limiting.js";
import { HealthResponseSchema } from "@pokertools/types";
import {
  ORCHESTRATION_SCOPE,
  type ServiceScopeName,
  type TableScope,
} from "./services/principal-manager.js";
import { createPlatformReadiness, buildReadinessResponse } from "./services/readiness-adapters.js";
import type { CreatePlatformReadinessOptions } from "./services/readiness-adapters.js";
import { createIncidentReadinessCheck } from "./services/incident-readiness.js";

/**
 * Scanner for the global SERVICE boundary. Table scopes authorize the canonical
 * table protocol; `competition:orchestrate` authorizes the competition
 * provisioning surface. Any other REST route is categorically denied for
 * machine credentials (no admin, finance, custody, user, tournament-management
 * or auth-operator access).
 */
function serviceRequiredScope(method: string, routeUrl: string): ServiceScopeName | null {
  // The global table collection is not part of the SERVICE surface: a bound
  // credential reaches only its own room through GET /tables/:id, so the
  // collection listing can never leak other rooms.
  if (routeUrl === "/tables") return null;
  if (routeUrl === "/tables/:id") {
    return method === "GET" ? "table:observe" : null;
  }
  if (routeUrl === "/tables/:id/action") {
    return method === "POST" ? "table:act" : null;
  }
  if (routeUrl === "/tables/:id/observation" || routeUrl === "/tables/:id/replay") {
    return method === "GET" ? "table:observe" : null;
  }
  if (["/tables/:id/buy-in", "/tables/:id/add-chips", "/tables/:id/stand"].includes(routeUrl)) {
    return method === "POST" ? "table:act" : null;
  }
  if (routeUrl === "/tables/:id/chat") {
    return method === "POST" ? "table:chat" : method === "GET" ? "table:observe" : null;
  }
  if (routeUrl === "/competitions") {
    return method === "POST" ? ORCHESTRATION_SCOPE : null;
  }
  if (
    [
      "/competitions/:id",
      "/competitions/:id/start",
      "/competitions/:id/cancel",
      "/competitions/:id/reconcile",
      "/competitions/:id/settle",
      "/competitions/:id/agent-credentials",
    ].includes(routeUrl)
  ) {
    return ORCHESTRATION_SCOPE;
  }
  return null;
}

export interface BuildAppOptions {
  /**
   * Test/embedded seam for the central readiness composition. Production never
   * passes this: the defaults are the real DB/Redis/queue/ledger/chain/custody
   * probes. Financial admission always evaluates the composed service.
   */
  readiness?: Partial<CreatePlatformReadinessOptions>;
  /** Lowered/explicit limits for focused tests; never accepted outside test. */
  rateLimiting?: Partial<RateLimitingOptions>;
  /** Explicit trusted ingress IP/CIDRs (default: trust no proxy). */
  trustedProxyCidrs?: string[];
}

export async function buildApp(options: BuildAppOptions = {}) {
  if (config.NODE_ENV !== "test" && options.rateLimiting !== undefined) {
    throw new Error(
      "Rate-limit overrides are test-only; configure production limits through the environment"
    );
  }
  const limits: RateLimitingOptions = {
    enabled: config.NODE_ENV !== "test",
    max: config.RATE_LIMIT_MAX,
    networkMax: config.RATE_LIMIT_NETWORK_MAX,
    ...options.rateLimiting,
  };
  const trustedProxies = parseTrustedProxyCidrs(
    options.trustedProxyCidrs ?? config.TRUSTED_PROXY_CIDRS
  );
  const app = Fastify({
    trustProxy: trustedProxies.length === 0 ? false : trustedProxies,
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

  // Install the coarse instance hook first, including before CORS can answer
  // preflight requests. The application route hook runs after authentication.
  await registerRateLimiting(app, limits);

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
        version: "1.0.15",
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

  // Operator incident resolution must re-verify real chain/accounting health in
  // the same transaction; without this injected check the route fails closed.
  app.decorate(
    "financialIncidentReadinessCheck",
    createIncidentReadinessCheck({ prisma: app.prisma })
  );

  // Authenticate decorator: validates the principal and attaches it to the
  // request. Wallet JWTs are checked against the DB session so server-side
  // revocation/expiry cannot be bypassed with a still-valid token. Opaque
  // SERVICE credentials are resolved by hashed lookup and are fully revocable.
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : undefined;

    // Prefixed service credentials are never parsed as wallet JWTs.
    if (app.principalManager.isServiceToken(bearer)) {
      const principal = await app.principalManager.authenticateServiceToken(bearer!);
      if (principal === null) {
        await reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.principal = principal;
      // Route identity uses the principal ID for both credential kinds.
      // SERVICE credentials have no wallet session (empty jti).
      request.user = { userId: principal.id, jti: "", address: undefined };
      return;
    }

    try {
      await request.jwtVerify();
      const { jti } = request.user;
      const session = await app.prisma.session.findUnique({
        where: { jti },
        include: { user: { select: { id: true, address: true, role: true, kind: true } } },
      });
      if (session === null || session.revoked || session.expiresAt <= new Date()) {
        throw new Error("Session invalid");
      }
      const principal = app.principalManager.buildWalletPrincipal({
        id: session.user.id,
        address: session.user.address,
        role: session.user.role,
        kind: session.user.kind,
      });
      // Fail closed: a session whose backing identity is not an addressable
      // WALLET must never be promoted to a wallet principal.
      if (principal === null) throw new Error("Not a wallet principal");
      request.principal = principal;
    } catch (_err) {
      await reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Operator authority is an explicit ADMIN wallet property. SERVICE
  // credentials are never operators, regardless of requested scopes.
  app.decorate("requireOperator", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal?.isOperator) {
      await reply.code(403).send({ error: "OPERATOR_REQUIRED" });
    }
  });

  // Reusable table authorization for REST handlers (game/SDK agents).
  // `persistedSeat` must come from authoritative state, never request body.
  app.decorate(
    "authorizeTable",
    (
      request: FastifyRequest,
      scope: TableScope,
      tableId?: string | null,
      persistedSeat?: number | null
    ) => app.principalManager.authorizeTable(request.principal, scope, tableId, persistedSeat)
  );

  // Resolve presented service credentials even on otherwise public routes.
  // Ignoring a bearer token there would bypass resource restrictions by treating
  // an authenticated service as an anonymous spectator.
  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ") &&
      app.principalManager.isServiceToken(authorization.slice(7).trim())
    ) {
      await app.authenticate(request, reply);
    }
  });

  // Enforce SERVICE scope boundaries before any handler runs. Wallet principals
  // are unaffected and retain their full regular gameplay scopes. Non-table
  // resources (finance, custody, admin, operator auth, room/table creation) are
  // categorically denied to machine credentials.
  app.addHook("preHandler", async (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== "SERVICE") return;

    const routeUrl = request.routeOptions?.url ?? "";
    // These public operational endpoints and the principal's own identity do
    // not confer gameplay, financial or operator authority.
    if (request.method === "GET" && ["/health", "/ready", "/auth/me"].includes(routeUrl)) return;
    const requiredScope = serviceRequiredScope(request.method, routeUrl);
    if (!requiredScope) {
      await reply.code(403).send({ error: "SERVICE_SCOPE_FORBIDDEN" });
      return;
    }

    // Orchestration is a narrow, non-table provisioning grant. It carries no
    // resource restrictions and never reaches the table authorization path.
    if (requiredScope === ORCHESTRATION_SCOPE) {
      if (!principal.scopes.includes(ORCHESTRATION_SCOPE)) {
        await reply.code(403).send({ error: "SERVICE_SCOPE_FORBIDDEN" });
      }
      return;
    }

    const tableId = (request.params as { id?: string } | undefined)?.id ?? null;

    // Seat restrictions are checked against the principal's authoritative seat
    // in engine state — never a client-supplied actor seat. An unrestrictable
    // or unknown seat fails closed inside authorizeTable.
    let persistedSeat: number | null = null;
    if (principal.restrictions.seat !== null && tableId) {
      const state = await app.gameManager.getState(tableId).catch(() => null);
      const index = state?.players.findIndex((player) => player?.id === principal.id) ?? -1;
      persistedSeat = index >= 0 ? index : null;
      if (persistedSeat === null && routeUrl === "/tables/:id/buy-in") {
        // Selecting a destination seat for a claim is resource selection, not
        // actor selection. The route validates it and always seats principal.id.
        const requestedSeat = (request.body as { seat?: unknown } | undefined)?.seat;
        if (
          typeof requestedSeat === "number" &&
          Number.isInteger(requestedSeat) &&
          requestedSeat >= 0 &&
          requestedSeat <= 9
        ) {
          persistedSeat = requestedSeat;
        }
      }
    }

    const authorization = await app.principalManager.authorizeTableRequest({
      principal,
      scope: requiredScope,
      tableId,
      persistedSeat,
      // Durable historical-seat proof applies only to canonical action replay.
      canonicalAction: routeUrl === "/tables/:id/action" ? request.body : undefined,
    });
    if (!authorization.allowed) {
      await reply.code(403).send({ error: authorization.reason });
    }
  });

  // Encapsulated route plugins inherit their parent's handler at registration.
  // Install the sanitized canonical boundary before registering any routes.
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = err.statusCode ? Number(err.statusCode) : 500;
    const code = typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
    if (code === "RISK_DENIED") {
      app.observabilityManager.increment("pokertools_risk_denials_total", {
        route: request.routeOptions.url ?? request.url,
      });
    }
    if (statusCode >= 500) {
      // Driver errors can contain database/RPC credentials; neither return nor
      // log the untrusted error object in the public request path.
      request.log.error({ requestId: request.id }, "Unhandled request error");
      return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error" });
    }
    return reply.code(statusCode).send({ error: code, message: err.message });
  });

  // Routes
  await app.register(authRoutes, { prefix: "/auth", strictRateLimits: limits.enabled });
  await app.register(tableRoutes, { prefix: "/tables" });
  await app.register(tournamentRoutes, { prefix: "/tournaments" });
  await app.register(competitionRoutes, { prefix: "/competitions" });
  await app.register(userRoutes, { prefix: "/user" });
  await app.register(wsRoutes, { prefix: "/ws" });
  await app.register(financeRoutes, { prefix: "/finance" });
  await app.register(notesRoutes, { prefix: "/notes" });
  await app.register(chipRoutes, { prefix: "/chips" });
  if (config.NODE_ENV === "test" && config.ENABLE_TEST_ROUTES === "true") {
    await app.register(testRoutesPlugin);
  }

  app.get("/health", () => HealthResponseSchema.parse({ status: "ok", timestamp: Date.now() }));

  const readiness = createPlatformReadiness(app, {
    custodyEvidenceReader: {
      read: () =>
        app.prisma.custodyHeartbeat.findMany({
          orderBy: { observedAt: "desc" },
          take: 1000,
        }),
    },
    ...options.readiness,
  });
  app.decorate("platformReadiness", readiness);
  // Explicit paid-admission policy (defaults from configuration; embedders may
  // narrow it). Readiness is always evaluated separately and independently.
  app.decorate("competitionPolicy", { paidEnabled: config.COMPETITION_PAID_ENABLED });
  app.get("/ready", async (_request, reply) => {
    const report = await readiness.evaluate();
    return reply.code(report.ready ? 200 : 503).send(buildReadinessResponse(report));
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
