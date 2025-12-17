import { cleanEnv, str, num } from "envalid";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root or package-level
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

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

  // Wallet Configuration
  HOT_WALLET_DERIVATION_PATH: str({ default: "m/44'/60'/0'/0/0" }),

  // Smart Contracts (Deployed Addresses)
  BATCH_SWEEPER_ADDRESS_MAINNET: str({ default: "" }),
  BATCH_SWEEPER_ADDRESS_POLYGON: str({ default: "" }),
  BATCH_SWEEPER_ADDRESS_LOCAL: str({ default: "" }),

  // Telegram
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_ADMIN_CHAT_ID: str(),

  // Operational Thresholds
  MAX_GAS_PRICE_GWEI: num({ default: 50 }),
  MIN_SWEEP_VALUE_USD: num({ default: 10 }),
  LOW_GAS_THRESHOLD_ETH: num({ default: 0.1 }),

  // Security
  JWT_SECRET: str(),

  // Velocity Limits (Risk Management)
  MAX_SINGLE_WITHDRAWAL_USD: num({ default: 5000 }),
  MAX_DAILY_WITHDRAWAL_USD: num({ default: 50000 }),

  // Logging
  LOG_LEVEL: str({ default: "info" }),
});

export const SECRETS = {
  MASTER_MNEMONIC,
};
