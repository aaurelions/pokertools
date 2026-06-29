import { cleanEnv, str, num } from "envalid";

export const config = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),
  PORT: num({ default: 3000 }),
  HOST: str({ default: "0.0.0.0" }),

  DATABASE_URL: str(),
  REDIS_URL: str({ default: "redis://localhost:6379" }),

  JWT_SECRET: str(),
  COOKIE_SECRET: str(),
  WALLET_ENCRYPTION_SECRET: str(),

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
});

export function allowedSiweChainIds(): Set<number> {
  return new Set(
    config.ALLOWED_SIWE_CHAIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}
