/**
 * Per-file environment wiring for finance acceptance.
 *
 * Runs before test modules so `packages/api/src/config.ts` (which validates the
 * environment at import time) reads the disposable PostgreSQL/Redis started by
 * `global-setup.ts`. Values come from the JSON handoff written there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANDOFF = path.join(os.tmpdir(), "pokertools-finance-acceptance-infra.json");

if (!fs.existsSync(HANDOFF)) {
  throw new Error(
    "Finance acceptance infrastructure handoff is missing. Run via vitest.finance.config.ts."
  );
}

const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8")) as {
  databaseUrl: string;
  redisUrl: string;
  chainARpc: string;
  chainBRpc: string;
};

process.env.NODE_ENV = "test";
process.env.PT_FINANCE_DATABASE_URL = handoff.databaseUrl;
process.env.PT_FINANCE_REDIS_URL = handoff.redisUrl;
process.env.DATABASE_URL = handoff.databaseUrl;
process.env.REDIS_URL = handoff.redisUrl;
process.env.PT_CHAIN_A_RPC = handoff.chainARpc;
process.env.PT_CHAIN_B_RPC = handoff.chainBRpc;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-finance-acceptance";
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? "test-cookie-secret-finance-acceptance";
process.env.ENABLE_TEST_ROUTES = "false";
process.env.ALLOWED_SIWE_CHAIN_IDS = "31337,31338,1";
process.env.LOG_LEVEL = "error";
delete process.env.WALLET_XPRIV_ENCRYPTION_SECRET;
delete process.env.MASTER_MNEMONIC;
