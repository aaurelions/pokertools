/**
 * Custody runtime assembly.
 *
 * Builds the canonical withdrawal workflow from the
 * shared generated Prisma client plus the API-owned finance-core adapters:
 *
 *  - accounting: `createCustodyAccounting` (canonical AtomicLedger journal,
 *    journal-id updates only, never the custody lifecycle `state`),
 *  - chain reads: `createAssetBackedCustodyQuorumReader` (validated
 *    ChainRegistry quorum for receipts, canonical blocks, native gas, token
 *    custody, settlement height and treasury nonce).
 *
 * The finance-core package is imported dynamically so the runtime module can be
 * loaded (e.g. for configuration parsing) without requiring the API build.
 * Callers may still inject fakes for tests.
 */
import type { CustodyLogger } from "./core/types.js";
import {
  PrismaAssetRegistry,
  PrismaIncidentStore,
  PrismaWithdrawalStore,
} from "./core/prisma-store.js";
import type { PrismaClient } from "@pokertools/api/database";
import type { RpcQuorumReader, TreasuryAccounting } from "./core/types.js";
import { SYSTEM_CLOCK } from "./core/types.js";
import {
  staticAccountResolver,
  ViemTreasuryBroadcaster,
  ViemTreasurySigner,
} from "./core/viem-ports.js";
import { WithdrawalWorkflow } from "./core/withdrawal-workflow.js";
import { CustodyWorker } from "./workers/custody-worker.js";
import { CustodyHeartbeatWriter } from "./workers/heartbeat-writer.js";

export interface CustodyRuntimeConfig {
  databaseUrl: string;
  workerIntervalMs: number;
  reconcileIntervalMs: number;
  quorumThreshold: number;
  minQuorum: number;
  treasurySigningKeysJson: string;
  /** Stable worker identity for durable heartbeat rows. */
  workerId?: string;
}

export interface CustodyRuntimeDeps {
  prisma: PrismaClient;
  config: CustodyRuntimeConfig;
  logger: CustodyLogger;
  /** Real accounting implementation. Defaults to the API ledger adapter. */
  accounting?: TreasuryAccounting;
  /** Chain quorum reader. Defaults to the API ChainRegistry adapter. */
  quorum?: RpcQuorumReader;
}

export interface CustodyRuntime {
  workflow: WithdrawalWorkflow;
  worker: CustodyWorker;
  heartbeats: CustodyHeartbeatWriter;
}

const SIGNING_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Parse `{"31337":"0x..."}` without ever logging the values. */
export function parseTreasurySigningKeys(json: string): Map<number, `0x${string}`> {
  const result = new Map<number, `0x${string}`>();
  if (!json.trim()) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("TREASURY_SIGNING_KEYS_JSON is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TREASURY_SIGNING_KEYS_JSON must be an object of chainId to key");
  }
  for (const [chainId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(chainId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid chainId in TREASURY_SIGNING_KEYS_JSON: ${chainId}`);
    }
    if (typeof value !== "string" || !SIGNING_KEY_PATTERN.test(value)) {
      throw new Error(`Invalid treasury signing key for chain ${chainId}`);
    }
    result.set(id, value as `0x${string}`);
  }
  return result;
}

export async function buildCustodyRuntime(deps: CustodyRuntimeDeps): Promise<CustodyRuntime> {
  const store = new PrismaWithdrawalStore(deps.prisma, deps.config.databaseUrl);
  const incidents = new PrismaIncidentStore(deps.prisma);
  const assets = new PrismaAssetRegistry(deps.prisma);

  const accounts = staticAccountResolver(
    parseTreasurySigningKeys(deps.config.treasurySigningKeysJson)
  );
  const signer = new ViemTreasurySigner(accounts);
  const broadcaster = new ViemTreasuryBroadcaster();

  const financeCore = await import("@pokertools/api/finance-core");
  const accounting =
    deps.accounting ??
    financeCore.createCustodyAccounting({
      prisma: deps.prisma,
    });
  const quorum =
    deps.quorum ??
    financeCore.createAssetBackedCustodyQuorumReader(deps.prisma, {
      quorum: deps.config.quorumThreshold,
      minFanout: deps.config.minQuorum,
      logger: deps.logger,
    });

  const workflow = new WithdrawalWorkflow({
    store,
    incidents,
    assets,
    accounting,
    signer,
    quorum,
    broadcaster,
    clock: SYSTEM_CLOCK,
    logger: deps.logger,
    config: { minQuorum: deps.config.minQuorum },
  });

  const heartbeats = new CustodyHeartbeatWriter({
    prisma: deps.prisma,
    assets,
    quorum,
    accounts,
    workerId: deps.config.workerId ?? `custody-${process.pid}`,
    clock: SYSTEM_CLOCK,
    logger: deps.logger,
  });

  const worker = new CustodyWorker(
    workflow,
    assets,
    deps.logger,
    {
      intervalMs: deps.config.workerIntervalMs,
      reconcileIntervalMs: deps.config.reconcileIntervalMs,
    },
    heartbeats
  );

  return { workflow, worker, heartbeats };
}
