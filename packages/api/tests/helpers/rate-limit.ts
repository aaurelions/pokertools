/// <reference path="../../types/fastify.d.ts" />
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { Redis } from "ioredis";
import { SeatObservationSchema, type SeatObservation } from "@pokertools/types";
import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { generateServiceToken, hashServiceToken } from "../../src/services/principal-manager.js";

/**
 * Fixtures for the principal/network rate-limiting seam on `buildApp`:
 *   options.rateLimiting?: { enabled?: boolean; max?: number; networkMax?: number }
 *   options.trustedProxyCidrs?: string[]   // explicit IP/CIDR allow-list; default false
 *
 * Build (and fully ready) the API with the rate-limiting options. Every call
 * returns an app whose limiter state is independent unless the stores are
 * Redis-backed (resetRateLimitState covers both).
 */
export async function buildRateLimitedApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = await buildApp(options);
  await app.ready();
  return app;
}

let rateLimitRedis: Redis | undefined;

function getRateLimitRedis(): Redis {
  rateLimitRedis ??= new Redis(process.env.REDIS_URL || "redis://localhost:6379/1", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return rateLimitRedis;
}

/**
 * Drop every limiter counter before a test. The stores may be Redis-backed
 * (shared across app instances), so isolation cannot rely on a fresh app alone.
 * Safe here because the API suite runs with fileParallelism=false against the
 * dedicated test Redis DB, matching tests/setup.ts.
 */
export async function resetRateLimitState(): Promise<void> {
  await getRateLimitRedis().flushdb();
}

export async function closeRateLimitRedis(): Promise<void> {
  if (!rateLimitRedis) return;
  if (rateLimitRedis.status !== "end") {
    await rateLimitRedis.quit().catch(() => undefined);
  }
  rateLimitRedis = undefined;
}

export interface ServiceFixture {
  principalId: string;
  credentialId: string;
  token: string;
}

export interface ServiceFixtureOptions {
  scopes: Array<"table:observe" | "table:act" | "table:chat" | "competition:orchestrate">;
  tableId?: string | null;
  seat?: number | null;
  revoked?: boolean;
  /** Reuse an existing SERVICE backing principal (e.g. credential rotation). */
  principalId?: string;
  name?: string;
}

/**
 * Persist a real SERVICE backing principal plus a hashed credential row
 * (mirrors the wire fixtures other service tests create via the operator route).
 */
export async function createServiceFixture(
  app: FastifyInstance,
  options: ServiceFixtureOptions
): Promise<ServiceFixture> {
  const principalId =
    options.principalId ??
    (
      await app.prisma.user.create({
        data: {
          username: `rl_svc_${crypto.randomUUID().slice(0, 12)}`,
          kind: "SERVICE",
        },
      })
    ).id;

  const token = generateServiceToken();
  const credential = await app.prisma.serviceCredential.create({
    data: {
      userId: principalId,
      name: options.name ?? `rl-cred-${crypto.randomUUID().slice(0, 12)}`,
      keyHash: hashServiceToken(token),
      scopes: options.scopes,
      tableId: options.tableId ?? null,
      seat: options.seat ?? null,
      revoked: options.revoked ?? false,
    },
  });

  return { principalId, credentialId: credential.id, token };
}

/**
 * A syntactically valid service credential that was never persisted: the
 * "hostile credential" shape resolved through the hashed lookup as unknown.
 */
export function mintUnregisteredServiceToken(): string {
  return generateServiceToken();
}

export async function cleanupServicePrincipal(
  app: FastifyInstance,
  principalId: string
): Promise<void> {
  await app.prisma.serviceCredential
    .deleteMany({ where: { userId: principalId } })
    .catch(() => undefined);
  await app.prisma.user.delete({ where: { id: principalId } }).catch(() => undefined);
}

/** Issue a second durable wallet session/JWT for an existing wallet principal. */
export async function createWalletSession(
  app: FastifyInstance,
  user: { id: string; address: string }
): Promise<{ token: string; jti: string }> {
  const jti = `rl_${crypto.randomUUID()}`;
  const token = await app.jwt.sign(
    { userId: user.id, address: user.address, jti },
    { jti, expiresIn: "1h" }
  );
  await app.prisma.session.create({
    data: { userId: user.id, jti, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  return { token, jti };
}

/** Real spectator-enabled cash table created directly through the game manager. */
export async function createRateLimitTable(
  app: FastifyInstance,
  name = `rl_table_${crypto.randomUUID().slice(0, 8)}`
): Promise<string> {
  return app.gameManager.createTable({
    name,
    mode: "CASH",
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 6,
    allowSpectators: true,
  });
}

export interface RateLimitRequestOptions {
  method?: "GET" | "POST" | "OPTIONS";
  url: string;
  token?: string;
  remoteAddress?: string;
  forwardedFor?: string;
  payload?: string | object;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * `app.inject` wrapper that can set the synthetic socket address and an
 * X-Forwarded-For header, which is what the limiter keying is observed through.
 */
export async function rateLimitRequest(
  app: FastifyInstance,
  options: RateLimitRequestOptions
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.forwardedFor !== undefined) headers["x-forwarded-for"] = options.forwardedFor;
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;

  return app.inject({
    method: options.method ?? "GET",
    url: options.url,
    headers,
    remoteAddress: options.remoteAddress,
    payload: options.payload,
  });
}

/**
 * Fetch the strict server-issued observation menu for a principal at a chosen
 * synthetic source IP (test-utils `getObservation` cannot set remoteAddress).
 * Mirrors that helper: non-200 throws, and the shared strict schema validates.
 */
export async function observeAt(
  app: FastifyInstance,
  options: { token: string; tableId: string; remoteAddress?: string }
): Promise<SeatObservation> {
  const response = await rateLimitRequest(app, {
    url: `/tables/${options.tableId}/observation`,
    token: options.token,
    remoteAddress: options.remoteAddress,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Failed to get observation: ${response.statusCode} ${response.body}`);
  }
  return SeatObservationSchema.parse(JSON.parse(response.body)) as SeatObservation;
}
