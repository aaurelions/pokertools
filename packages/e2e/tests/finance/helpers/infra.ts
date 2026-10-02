/**
 * Resolve the fresh infrastructure URLs for a test worker.
 *
 * Prefers process env (globally set by cleanup setup); falls back to the JSON
 * handoff written by the same setup for fork-pool workers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANDOFF = path.join(os.tmpdir(), "pokertools-finance-acceptance-infra.json");

interface Handoff {
  databaseUrl: string;
  redisUrl: string;
  chainARpc: string;
  chainBRpc: string;
}

let cached: Handoff | null = null;

export function requireInfra(): Handoff {
  if (cached) return cached;

  const fromEnv: Partial<Handoff> = {
    databaseUrl: process.env.PT_FINANCE_DATABASE_URL ?? process.env.DATABASE_URL,
    redisUrl: process.env.PT_FINANCE_REDIS_URL ?? process.env.REDIS_URL,
    chainARpc: process.env.PT_CHAIN_A_RPC,
    chainBRpc: process.env.PT_CHAIN_B_RPC,
  };

  let fromFile: Partial<Handoff> = {};
  if (fs.existsSync(HANDOFF)) {
    fromFile = JSON.parse(fs.readFileSync(HANDOFF, "utf8")) as Partial<Handoff>;
  }

  {
    const merged = { ...fromFile, ...fromEnv };
    if (!merged.databaseUrl || !merged.redisUrl || !merged.chainARpc || !merged.chainBRpc) {
      throw new Error(
        "Fresh finance acceptance infrastructure is not running. " +
          "Run via the finance acceptance config (globalSetup starts Postgres, Redis and two Anvil chains)."
      );
    }
    cached = merged as Handoff;
    return cached;
  }
}

export type { Handoff };
