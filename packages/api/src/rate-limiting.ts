import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface RateLimitingOptions {
  enabled: boolean;
  max: number;
  networkMax: number;
}

/** Explicit ingress addresses only; never infer trust from forwarded headers. */
export function parseTrustedProxyCidrs(value: string | readonly string[]): string[] {
  const entries = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(entries)) throw new TypeError("Trusted proxies must be IP/CIDR addresses");
  return entries
    .map((entry: string) => {
      if (typeof entry !== "string") throw new TypeError("Invalid trusted proxy address");
      return entry.trim();
    })
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("/");
      const family = isIP(parts[0]);
      if (!family || parts.length > 2) throw new Error("Invalid trusted proxy IP/CIDR");
      if (parts.length === 2) {
        const prefix = Number(parts[1]);
        if (!/^\d+$/.test(parts[1]) || prefix < 1 || prefix > (family === 4 ? 32 : 128)) {
          throw new Error("Invalid or unrestricted trusted proxy CIDR");
        }
      }
      return entry;
    });
}

/** Preserve the plugin's IPv4-mapped IPv6 and IPv6-subnet abuse protection. */
export function ipRateLimitKey(request: FastifyRequest): string {
  return `ip:${normalizeIP(request.ip)}`;
}

export async function registerRateLimiting(
  app: FastifyInstance,
  options: RateLimitingOptions
): Promise<void> {
  for (const max of [options.max, options.networkMax]) {
    if (!Number.isSafeInteger(max) || max < 1)
      throw new RangeError("Rate limits must be positive safe integers");
  }
  await app.register(rateLimit, {
    global: options.enabled,
    max: options.max,
    timeWindow: "1 minute",
    // Authentication is in onRequest. Charge before body parsing and SERVICE
    // authorization, including malformed bodies and forbidden-scope requests.
    hook: "preParsing",
    keyGenerator: (request) => {
      const principal = request.principal;
      return principal === undefined || principal === null
        ? ipRateLimitKey(request)
        : `principal:${principal.kind}:${principal.id}`;
    },
  });
  if (!options.enabled) return;

  // Separate child store + namespaced key. createRateLimit does not set the
  // plugin's per-request rateLimitRan marker; both layers must actually run.
  // Keep the original per-API-process storage semantics, without coupling
  // readiness/health to Redis availability.
  const networkLimit = app.createRateLimit({
    max: options.networkMax,
    timeWindow: "1 minute",
    keyGenerator: (request) => `network:${ipRateLimitKey(request)}`,
  });
  app.addHook("onRequest", async (request, reply) => {
    const result = await networkLimit(request);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header("x-ratelimit-limit", result.max);
    reply.header("x-ratelimit-remaining", 0);
    reply.header("x-ratelimit-reset", result.ttlInSeconds);
    reply.header("retry-after", result.ttlInSeconds);
    throw Object.assign(new Error("Network rate limit exceeded"), {
      statusCode: 429,
      code: "RATE_LIMITED",
    });
  });
}
