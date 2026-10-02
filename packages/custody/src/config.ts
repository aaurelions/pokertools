import { cleanEnv, str, num } from "envalid";
import { assertCustodyProcessEvidence, assertCustodyProcessSafety } from "./safety.js";

// Before dotenv: enforce only the compiled-evidence gate. Configuration values
// may legitimately arrive from an environment file loaded on the next lines.
assertCustodyProcessEvidence(process.env);
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root or package-level
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

// Environment files may supply NODE_ENV too. Recheck before reading any secret
// files or mnemonic material; the initial check still rejects explicit production
// before dotenv itself runs.
assertCustodyProcessSafety(process.env);

/**
 * The canonical custody worker signs with per-chain treasury keys supplied via
 * `TREASURY_SIGNING_KEYS_JSON`; no mnemonic, xpriv or JWT material is read.
 */

export const config = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "production", "test"], default: "development" }),

  // Infrastructure
  DATABASE_URL: str(),
  REDIS_URL: str({ default: "redis://localhost:6379" }),

  // Canonical custody worker
  CUSTODY_WORKER_INTERVAL_MS: num({ default: 5000 }),
  CUSTODY_RECONCILE_INTERVAL_MS: num({ default: 5 * 60 * 1000 }),
  CUSTODY_QUORUM_THRESHOLD: num({ default: 2 }),
  CUSTODY_MIN_QUORUM: num({ default: 2 }),
  /**
   * JSON object mapping chainId to a `0x` treasury signing private key. Kept in
   * custody only; the API never reads it. Left empty to run monitoring-only.
   */
  TREASURY_SIGNING_KEYS_JSON: str({ default: "" }),

  // Logging
  LOG_LEVEL: str({ default: "info" }),
});
