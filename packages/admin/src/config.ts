import { cleanEnv, str, num, makeValidator } from "envalid";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root or package-level
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

/**
 * Helper to load secrets from file (Docker Secret) or Env
 */
const loadSecret = (envVarName: string, fileVarName: string): string => {
  if (process.env[fileVarName]) {
    try {
      return fs.readFileSync(process.env[fileVarName], "utf8").trim();
    } catch (_e) {
      console.error(`Failed to read secret file: ${process.env[fileVarName]}`);
    }
  }
  return process.env[envVarName] ?? "";
};

const DEV_SECRET_FRAGMENTS = [
  "dev-jwt-secret-not-for-production",
  "dev-wallet-encryption-secret-not-for-production",
  "CHANGE_THIS_IN_PRODUCTION",
  "test-jwt-secret",
  "e2e-jwt-secret",
];

const productionSecret = makeValidator((input: string) => {
  if (process.env.NODE_ENV === "production") {
    if (!input) throw new Error("Production secret must be set");
    for (const fragment of DEV_SECRET_FRAGMENTS) {
      if (input.includes(fragment)) {
        throw new Error(
          `Production security gate: secret contains a dev/test default value (matches "${fragment}").`
        );
      }
    }
  }
  return input;
});

// Manually load mnemonic
const MASTER_MNEMONIC = loadSecret("MASTER_MNEMONIC", "MASTER_MNEMONIC_FILE");

if (!MASTER_MNEMONIC) {
  throw new Error("MASTER_MNEMONIC or MASTER_MNEMONIC_FILE must be set");
}

export const config = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),

  // Infrastructure
  DATABASE_URL: str(),
  REDIS_URL: str({ default: "redis://localhost:6379" }),
  DEFAULT_CURRENCY: str({ default: "USDC" }),

  // Wallet Configuration
  HOT_WALLET_DERIVATION_PATH: str({ default: "m/44'/60'/0'/0/0" }),

  // Smart Contracts (Deployed Addresses)
  BATCH_SWEEPER_ADDRESS_MAINNET: str({ default: "" }),
  BATCH_SWEEPER_ADDRESS_POLYGON: str({ default: "" }),
  BATCH_SWEEPER_ADDRESS_LOCAL: str({ default: "" }),
  SWEEPER_CONTRACT_MAP: str({ default: "" }),

  // Telegram
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_ADMIN_CHAT_ID: str(),

  // Operational Thresholds
  MAX_GAS_PRICE_GWEI: num({ default: 50 }),
  MIN_SWEEP_VALUE_USD: num({ default: 10 }),
  LOW_GAS_THRESHOLD_ETH: num({ default: 0.1 }),

  // RPC resilience
  RPC_RETRY_COUNT: num({ default: 3 }),
  RPC_RETRY_DELAY_MS: num({ default: 1000 }),
  RPC_TIMEOUT_MS: num({ default: 10_000 }),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: num({ default: 5 }),
  CIRCUIT_BREAKER_OPEN_MS: num({ default: 30_000 }),
  WITHDRAWAL_SIGNATURE_MAX_AGE_MS: num({ default: 5 * 60 * 1000 }),
  WITHDRAWAL_POLL_INTERVAL_MS: num({ default: 3000 }),
  RECOVERY_SCAN_INTERVAL_MS: num({ default: 5 * 60 * 1000 }),
  TRANSACTION_MONITOR_INTERVAL_MS: num({ default: 60 * 1000 }),
  SWEEP_INTERVAL_MS: num({ default: 10 * 60 * 1000 }),
  GAS_MONITOR_INTERVAL_MS: num({ default: 30 * 60 * 1000 }),
  STUCK_WITHDRAWAL_MAX_AGE_MS: num({ default: 6 * 60 * 60 * 1000 }),

  // Security
  JWT_SECRET: productionSecret(),

  // Velocity Limits (Risk Management)
  MAX_SINGLE_WITHDRAWAL_USD: num({ default: 5000 }),
  MAX_DAILY_WITHDRAWAL_USD: num({ default: 50000 }),

  // Security
  WALLET_ENCRYPTION_SECRET: productionSecret(),
  WALLET_XPRIV_ENCRYPTION_SECRET: productionSecret({
    desc: "Separate secret for private wallet material (xpriv encryption). Required in production.",
  }),
  PBKDF2_ITERATIONS: num({ default: 600_000 }),

  // Logging
  LOG_LEVEL: str({ default: "info" }),
});

export const SECRETS = {
  MASTER_MNEMONIC,
};
