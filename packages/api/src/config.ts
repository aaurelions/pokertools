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

  DEFAULT_CURRENCY: str({ default: "USDC" }),

  JWT_SECRET: productionSecret(),
  COOKIE_SECRET: productionSecret(),
  WALLET_ENCRYPTION_SECRET: productionSecret(),
  WALLET_XPRIV_ENCRYPTION_SECRET: str({
    default: "",
    desc: "Separate secret for private wallet material (API should not have this set in production)",
  }),
  PBKDF2_ITERATIONS: num({ default: 600_000 }),

  LOG_LEVEL: str({ default: "info", choices: ["debug", "info", "warn", "error"] }),

  SESSION_TTL_SECONDS: num({ default: 7 * 24 * 60 * 60 }),
  RATE_LIMIT_MAX: num({ default: 100 }),
  AUTH_NONCE_RATE_LIMIT_MAX: num({ default: 5 }),
  AUTH_LOGIN_RATE_LIMIT_MAX: num({ default: 10 }),
  MAX_WITHDRAWAL_AMOUNT_CENTS: num({ default: 1_000_000 }),
  TABLE_REDIS_TTL_SECONDS: num({ default: 24 * 60 * 60 }),
  TABLE_LOCK_TTL_MS: num({ default: 10_000 }),
  TABLE_LOCK_TTL_MS_TEST: num({ default: 15_000 }),
  ACTION_TIMEOUT_SECONDS: num({ default: 30 }),
  DEPOSIT_MONITOR_INTERVAL_MS: num({ default: 15_000 }),
  RECONCILIATION_INTERVAL_MS: num({ default: 5 * 60 * 1000 }),
  RISK_SCORE_THRESHOLD: num({ default: 70 }),
  RISK_WITHDRAW_USER_LIMIT: num({ default: 5 }),
  RISK_BUY_IN_USER_LIMIT: num({ default: 12 }),
  RISK_ACTION_USER_LIMIT: num({ default: 60 }),
  RISK_WITHDRAW_IP_LIMIT: num({ default: 20 }),
  RISK_BUY_IN_IP_LIMIT: num({ default: 40 }),
  RISK_ACTION_IP_LIMIT: num({ default: 200 }),

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

  // ---------------------------------------------------------------------------
  // Operational constants. Defaults are conservative; override via the
  // environment to tune for deployment scale and latency requirements.
  // ---------------------------------------------------------------------------
  INITIAL_SCAN_LOOKBACK_BLOCKS: num({
    default: 100,
    desc: "Number of blocks to look back on the first deposit scan of a chain (default 100)",
  }),
  DEPOSIT_SCAN_CONCURRENCY: num({ default: 5, desc: "Deposit monitor worker concurrency" }),
  DEPOSIT_SCAN_MAX_RPCS: num({
    default: 10,
    desc: "Max RPC calls per second for the deposit monitor limiter",
  }),
  DEPOSIT_SCAN_LIMIT_DURATION_MS: num({
    default: 1000,
    desc: "Duration window in ms for the deposit monitor limiter",
  }),
  SETTLE_HAND_LOCK_TTL_MS: num({ default: 5000, desc: "Redis lock TTL for settle-hand worker" }),
  NEXT_HAND_LOCK_TTL_MS: num({ default: 3000, desc: "Redlock TTL for next-hand worker" }),
  REDLOCK_RETRY_COUNT: num({ default: 3, desc: "Redlock retry attempts" }),
  REDLOCK_RETRY_DELAY_MS: num({ default: 100, desc: "Redlock retry delay in ms" }),
  REDLOCK_DRIFT_FACTOR: num({ default: 0.01, desc: "Redlock drift factor" }),
  RECONCILIATION_WINDOW_HOURS: num({
    default: 24,
    desc: "Reconciliation lookback window in hours",
  }),
  RECONCILIATION_BATCH_SIZE: num({ default: 100, desc: "Reconciliation batch size (take)" }),
  AUTO_DEAL_DELAY_MS: num({ default: 5000, desc: "Delay before auto-dealing the next hand" }),
  WITHDRAWAL_MESSAGE_TTL_MS: num({
    default: 5 * 60 * 1000,
    desc: "Max age of a signed withdrawal message in ms",
  }),
  NONCE_TTL_SECONDS: num({ default: 300, desc: "TTL of SIWE auth nonces in seconds" }),
  RETRY_TRANSIENT_ATTEMPTS: num({ default: 10, desc: "Retry attempts for transient failures" }),
  RETRY_TRANSIENT_BACKOFF_BASE_MS: num({
    default: 100,
    desc: "Base backoff for transient retries (multiplied by attempt number)",
  }),
  TABLE_LISTING_PAGE_SIZE: num({ default: 50, desc: "Default page size for table listing" }),
  IDEMPOTENCY_TTL_SECONDS: num({ default: 3600, desc: "TTL for idempotency records in seconds" }),
  TOURNAMENT_LOCK_TTL_MS: num({ default: 30000, desc: "Redlock TTL for tournament operations" }),
  TOURNAMENT_LISTING_PAGE_SIZE: num({
    default: 100,
    desc: "Default page size for tournament listing",
  }),
  MAX_TOURNAMENT_TABLES: num({
    default: 10,
    desc: "Maximum tables allowed in a multi-table tournament",
  }),
  WS_MAX_CONNECTIONS_PER_USER: num({
    default: 4,
    desc: "Max concurrent WebSocket connections per user",
  }),
  WS_MAX_PRE_AUTH_QUEUE: num({ default: 8, desc: "Max buffered pre-auth WebSocket messages" }),
  WS_HEARTBEAT_INTERVAL_MS: num({
    default: 30000,
    desc: "WebSocket heartbeat ping interval in ms",
  }),
});

export function allowedSiweChainIds(): Set<number> {
  return new Set(
    config.ALLOWED_SIWE_CHAIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}
