import { cleanEnv, str, num, makeValidator } from "envalid";

// ---------------------------------------------------------------------------
// Production security guard: refuse to start if any secret contains a
// well-known dev/test default.  This is a defence-in-depth layer — the Docker
// entrypoint also enforces this gate at container startup time.
// ---------------------------------------------------------------------------
const DEV_SECRET_FRAGMENTS = [
  "dev-jwt-secret-not-for-production",
  "dev-cookie-secret-not-for-production",
  "dev-wallet-encryption-secret-not-for-production",
  "CHANGE_THIS_IN_PRODUCTION",
  "test-jwt-secret",
  "e2e-jwt-secret",
];

const productionSecret = makeValidator((input: string) => {
  if (process.env.NODE_ENV === "production") {
    for (const fragment of DEV_SECRET_FRAGMENTS) {
      if (input.includes(fragment)) {
        throw new Error(
          `Production security gate: secret contains a dev/test default value (matches "${fragment}"). ` +
            "Generate a cryptographically strong random value (e.g. openssl rand -base64 32)."
        );
      }
    }
  }
  return input;
});

export const config = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),
  PORT: num({ default: 3000 }),
  HOST: str({ default: "0.0.0.0" }),

  DATABASE_URL: str(),
  REDIS_URL: str({ default: "redis://localhost:6379" }),

  JWT_SECRET: productionSecret(),
  COOKIE_SECRET: productionSecret(),
  WALLET_ENCRYPTION_SECRET: productionSecret(),
  WALLET_XPRIV_ENCRYPTION_SECRET: str({
    default: "",
    desc: "Separate secret for private wallet material (API should not have this set in production)",
  }),

  LOG_LEVEL: str({ default: "info", choices: ["debug", "info", "warn", "error"] }),

  // RPC configuration for blockchain clients
  RPC_RETRY_COUNT: num({ default: 3, desc: "Number of retries for RPC calls" }),
  RPC_RETRY_DELAY: num({ default: 1000, desc: "Delay between retries in milliseconds" }),
  RPC_TIMEOUT: num({ default: 10000, desc: "Timeout for RPC calls in milliseconds" }),

  // CORS origin - specific in production, broad in dev/test
  CORS_ORIGIN: str({ default: "" }),
  ALLOWED_SIWE_CHAIN_IDS: str({
    default: "1,31337",
    desc: "Comma-separated EIP-155 chain IDs accepted for SIWE login",
  }),
  METRICS_TOKEN: str({
    default: "",
    desc: "Bearer token required for /metrics in production. If unset in production, /metrics is disabled.",
  }),
  ENABLE_TEST_ROUTES: str({
    default: "false",
    choices: ["true", "false"],
    desc: "Explicit opt-in for test-only balance/state mutation routes. Must never be enabled outside isolated tests.",
  }),
  TOURNAMENT_BLIND_INTERVAL_MS: num({
    default: 900000,
    desc: "Interval in milliseconds between automatic blind level advances (default 15 min)",
  }),
  TOURNAMENT_BLIND_SCAN_INTERVAL_MS: num({
    default: 15000,
    desc: "Interval in milliseconds between tournament-blind worker scans (default 15 sec)",
  }),
});

export function allowedSiweChainIds(): Set<number> {
  return new Set(
    config.ALLOWED_SIWE_CHAIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}
