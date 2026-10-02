import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Canonical finance config surface.
 *
 * The legacy derived-address/finance fields were removed from `src/config.ts`.
 * These tests pin the canonical surface and prove validation is not weakened:
 * an invalid value is still rejected, and the public process safety gate still
 * blocks a production process (so custody secrets can never be required by the
 * public API).
 */

const LEGACY_FINANCE_KEYS = [
  "DEFAULT_CURRENCY",
  "MAX_WITHDRAWAL_AMOUNT_CENTS",
  "WITHDRAWAL_MESSAGE_TTL_MS",
  "DEPOSIT_MONITOR_INTERVAL_MS",
  "RPC_RETRY_COUNT",
  "RPC_RETRY_DELAY",
  "RPC_TIMEOUT",
  "INITIAL_SCAN_LOOKBACK_BLOCKS",
  "DEPOSIT_SCAN_CONCURRENCY",
  "DEPOSIT_SCAN_MAX_RPCS",
  "DEPOSIT_SCAN_LIMIT_DURATION_MS",
  "RECONCILIATION_WINDOW_HOURS",
] as const;

async function importConfig() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "file:./.runtime/config-validation.db");
  return import("../../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("canonical finance config", () => {
  it("exposes canonical finance fields and drops dead legacy fields", async () => {
    const { config } = await importConfig();

    expect(config.RECONCILIATION_INTERVAL_MS).toBeTypeOf("number");
    expect(config.RECONCILIATION_BATCH_SIZE).toBeTypeOf("number");
    expect(config.ALLOWED_SIWE_CHAIN_IDS).toBeTypeOf("string");

    // envalid's strict proxy throws on access to an unvalidated key; `in`
    // asserts the key was dropped from the spec without triggering the getter.
    for (const key of LEGACY_FINANCE_KEYS) {
      expect(key in config).toBe(false);
    }
  });

  it("still rejects an unsafe/invalid value for a validated field", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "file:./.runtime/config-validation.db");
    vi.stubEnv("LOG_LEVEL", "not-a-level");

    await expect(import("../../src/config.js")).rejects.toThrow();
  });

  it("still rejects a missing required field", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(import("../../src/config.js")).rejects.toThrow();
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  it("still blocks a public production process before any secret is read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_TEST_ROUTES", "false");

    // A non-PostgreSQL test datasource cannot admit production startup.
    await expect(import("../../src/config.js")).rejects.toThrow(/PRODUCTION_REQUIRES_POSTGRESQL/);
  });
});
