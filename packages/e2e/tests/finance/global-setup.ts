/**
 * Vitest global setup for finance/custody acceptance.
 *
 * Starts exactly one fresh PostgreSQL + Redis pair and one isolated two-chain
 * Anvil pair for the whole run. The PostgreSQL-provider Prisma client is
 * generated into a private runtime directory before any worker imports the API
 * or custody sources, and the canonical schema is pushed into the disposable
 * database. Infrastructure URLs are exposed to test workers via both environment
 * variables and a small JSON handoff file (fork-pool workers are not guaranteed
 * to observe env writes made here across all vitest versions).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHAIN_A_RPC,
  CHAIN_B_RPC,
  startTwoChainAnvil,
  stopTwoChainAnvil,
} from "./helpers/anvil-two-chain.js";
import {
  FINANCE_GENERATED_DIR,
  FINANCE_RUNTIME_DIR,
  startFreshInfra,
  type FreshInfra,
} from "./helpers/fresh-infra.js";

const HANDOFF = path.join(os.tmpdir(), "pokertools-finance-acceptance-infra.json");

let infra: FreshInfra | null = null;

export async function setup(): Promise<void> {
  // A stale private client from a previous schema revision must never be reused.
  fs.rmSync(FINANCE_GENERATED_DIR, { recursive: true, force: true });
  fs.mkdirSync(FINANCE_RUNTIME_DIR, { recursive: true });

  await startTwoChainAnvil();
  infra = await startFreshInfra();

  process.env.PT_FINANCE_DATABASE_URL = infra.databaseUrl;
  process.env.PT_FINANCE_REDIS_URL = infra.redisUrl;
  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.PT_CHAIN_A_RPC = CHAIN_A_RPC;
  process.env.PT_CHAIN_B_RPC = CHAIN_B_RPC;
  process.env.NODE_ENV = "test";

  const handoff = {
    databaseUrl: infra.databaseUrl,
    redisUrl: infra.redisUrl,
    chainARpc: CHAIN_A_RPC,
    chainBRpc: CHAIN_B_RPC,
  };
  fs.writeFileSync(HANDOFF, JSON.stringify(handoff), "utf8");
}

export async function teardown(): Promise<void> {
  fs.rmSync(HANDOFF, { force: true });
  await infra?.stop();
  infra = null;
  await stopTwoChainAnvil();
}
