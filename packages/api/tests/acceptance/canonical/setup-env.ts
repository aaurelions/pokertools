/**
 * Per-file environment wiring for the canonical acceptance suite.
 *
 * Runs before test modules so `src/config.ts` reads the acceptance database and
 * Redis. Values come from the JSON written by `global-setup.ts`.
 *
 * The canonical files run sequentially (one worker, no file parallelism)
 * against ONE disposable Redis, and every HTTP request originates from
 * loopback. The RiskManager keys its per-IP velocity window on the request IP
 * (`risk:<endpoint>:ip:<ip>`), so buy-ins from earlier files accumulate in
 * later files and can deny a later file's own first buy-in with RISK_DENIED
 * even though that file never breached a limit. Before the app boots for each
 * file, reset ONLY the `risk:*` velocity keys on the disposable acceptance
 * Redis. Table/session/queue and every other key are never touched (no
 * FLUSHALL/FLUSHDB), no limit is raised or disabled, and risk controls remain
 * fully enforced for the duration of every file.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { Redis } from "ioredis";

const envFile = resolve(import.meta.dirname, "../../../.runtime/acceptance/env.json");
const provisioned = JSON.parse(readFileSync(envFile, "utf8")) as {
  databaseUrl: string;
  redisUrl: string;
};

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = provisioned.databaseUrl;
process.env.REDIS_URL = provisioned.redisUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "acceptance-jwt-secret";
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? "acceptance-cookie-secret";
process.env.ENABLE_TEST_ROUTES = "false";
process.env.ALLOWED_SIWE_CHAIN_IDS = "31337,1";
process.env.LOG_LEVEL = "error";
// Explicit acceptance enable for paid competition admission. Readiness is
// still evaluated for real (fixtures + injected test chain-quorum seam); this
// flag never substitutes for readiness.
process.env.COMPETITION_PAID_ENABLED = process.env.COMPETITION_PAID_ENABLED ?? "true";
// Keep scheduled/lock timings tight but deterministic for race tests.
process.env.ACTION_TIMEOUT_SECONDS = process.env.ACTION_TIMEOUT_SECONDS ?? "2";

const RISK_KEY_PATTERN = "risk:*";
/** `startRedis`/`pickFreePort` always binds the disposable instance to loopback in this range. */
const ACCEPTANCE_REDIS_PORT_MIN = 21000;
const ACCEPTANCE_REDIS_PORT_MAX = 24000;
/** TEST-NET-2 address; never the loopback the suite's own traffic uses. */
const SELFTEST_IP = "198.51.100.7";

function assertDisposableAcceptanceRedis(redisUrl: string): void {
  const url = new URL(redisUrl);
  const port = Number(url.port);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    !loopback ||
    !Number.isInteger(port) ||
    port < ACCEPTANCE_REDIS_PORT_MIN ||
    port > ACCEPTANCE_REDIS_PORT_MAX
  ) {
    throw new Error(
      "Refusing the per-file risk reset outside the disposable canonical Redis " +
        `(expected loopback:${ACCEPTANCE_REDIS_PORT_MIN}-${ACCEPTANCE_REDIS_PORT_MAX}, got ${redisUrl})`
    );
  }
}

/** SCAN+DEL every `risk:*` velocity key; never FLUSHALL/FLUSHDB. */
async function clearRiskVelocityKeys(redis: Redis): Promise<number> {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", RISK_KEY_PATTERN, "COUNT", 100);
    cursor = next;
    for (let offset = 0; offset < keys.length; offset += 100) {
      const chunk = keys.slice(offset, offset + 100);
      if (chunk.length > 0) removed += await redis.del(...chunk);
    }
  } while (cursor !== "0");
  return removed;
}

function assertSelfTest(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[canonical-acceptance] risk isolation self-test failed: ${message}`);
  }
}

/**
 * Self-test executed before every file's app boot:
 * - the scoped reset removes `risk:*` keys while session/queue/table keys
 *   survive (it must never be a FLUSHALL);
 * - the real RiskManager still allows the limit-th buy-in and denies the
 *   (limit + 1)-th with the real config inside the same file (nothing disabled).
 * Synthetic identities are used and removed afterwards; loopback risk keys are
 * left to the per-file reset.
 */
async function runRiskIsolationSelfTest(redis: Redis): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const canaries: Record<string, string> = {
    [`session:canonical-selftest:${nonce}`]: "session",
    [`queue:canonical-selftest:${nonce}`]: "queue",
    [`table:canonical-selftest:${nonce}`]: "table",
  };
  const riskCanaries = [`risk:canonical-selftest:${nonce}`, `risk:buy-in:ip:${SELFTEST_IP}`];
  const canaryKeys = [...Object.keys(canaries), ...riskCanaries];

  try {
    await redis.mset(canaries);
    const seededAt = Date.now();
    for (const key of riskCanaries) await redis.zadd(key, seededAt, `${nonce}:${key}`);

    const removed = await clearRiskVelocityKeys(redis);
    assertSelfTest(
      removed >= riskCanaries.length,
      `expected at least ${riskCanaries.length} risk keys removed, got ${removed}`
    );
    for (const key of riskCanaries) {
      assertSelfTest((await redis.exists(key)) === 0, `risk key survived the scoped reset: ${key}`);
    }
    for (const key of Object.keys(canaries)) {
      assertSelfTest((await redis.exists(key)) === 1, `unrelated key was deleted: ${key}`);
    }

    const { config } = await import("../../../src/config.js");
    const { RiskManager, RiskDeniedError } = await import("../../../src/services/risk-manager.js");
    const limit = config.RISK_BUY_IN_IP_LIMIT;
    assertSelfTest(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 256,
      `unexpected RISK_BUY_IN_IP_LIMIT=${limit}`
    );

    const endpoint = "buy-in";
    const userId = `canonical-risk-selftest-${nonce}`;
    const ipKey = `risk:${endpoint}:ip:${SELFTEST_IP}`;
    const userKey = `risk:${endpoint}:${userId}`;
    const manager = new RiskManager(redis);
    const base = Date.now();
    const seed: Array<number | string> = [];
    for (let index = 0; index < limit - 1; index += 1) {
      seed.push(base - index, `${nonce}:seed:${index}`);
    }
    if (seed.length > 0) await redis.zadd(ipKey, ...seed);

    const request = { ip: SELFTEST_IP } as unknown as FastifyRequest;
    // The limit-th hit inside the window must still be allowed...
    await manager.assertAllowed({ userId, endpoint, request });
    // ...and the (limit + 1)-th must still be denied.
    let denied = false;
    try {
      await manager.assertAllowed({ userId, endpoint, request });
    } catch (error) {
      denied = error instanceof RiskDeniedError;
    }
    assertSelfTest(denied, `RiskManager did not deny the (limit + 1)-th buy-in at limit=${limit}`);

    await redis.del(ipKey, userKey);
  } finally {
    await redis.del(...canaryKeys).catch(() => undefined);
  }
}

assertDisposableAcceptanceRedis(provisioned.redisUrl);
const redis = new Redis(provisioned.redisUrl, {
  lazyConnect: false,
  maxRetriesPerRequest: 2,
  connectTimeout: 10_000,
});
try {
  await redis.ping();
  await runRiskIsolationSelfTest(redis);
  // Per-file initial state only: clear the shared-loopback risk velocity window
  // before the app boots. Mid-scenario risk enforcement is untouched.
  await clearRiskVelocityKeys(redis);
} catch (error) {
  throw new Error(
    `[canonical-acceptance] per-file risk isolation failed on ${provisioned.redisUrl}: ` +
      `${error instanceof Error ? error.message : String(error)}`
  );
} finally {
  redis.disconnect();
}
