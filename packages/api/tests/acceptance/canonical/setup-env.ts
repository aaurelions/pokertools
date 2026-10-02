/**
 * Per-file environment wiring for the canonical acceptance suite.
 *
 * Runs before test modules so `src/config.ts` reads the acceptance database and
 * Redis. Values come from the JSON written by `global-setup.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
process.env.WALLET_ENCRYPTION_SECRET =
  process.env.WALLET_ENCRYPTION_SECRET ?? "acceptance-wallet-secret";
process.env.ENABLE_TEST_ROUTES = "false";
process.env.ALLOWED_SIWE_CHAIN_IDS = "31337,1";
process.env.LOG_LEVEL = "error";
// Keep scheduled/lock timings tight but deterministic for race tests.
process.env.ACTION_TIMEOUT_SECONDS = process.env.ACTION_TIMEOUT_SECONDS ?? "2";
