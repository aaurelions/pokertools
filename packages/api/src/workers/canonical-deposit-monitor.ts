/**
 * Canonical deposit monitor.
 *
 * Advances CREDITED deposit claims toward deep finality and detects on-chain
 * reorgs. On a reorg it preserves the already-credited user liability, records
 * the shortfall through the finance-core `recordDepositReorg` path (no duplicate
 * obligation journal), freezes the chain in the registry, and freezes the asset.
 *
 * A lost RPC / quorum failure is never treated as a reorg: the claim status is
 * preserved and retried on a later pass.
 *
 * The workers entry point calls `bootstrapCanonicalDepositMonitor` for full
 * startup (asset-derived registry, services, BullMQ worker, repeatable job).
 */

import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { AtomicLedger } from "../services/atomic-ledger.js";
import { FinancialIntentService } from "../services/financial-intents.js";
import { FinancialIncidentService } from "../services/financial-incidents.js";
import {
  buildChainRegistryFromAssets,
  createPrismaChainFreezeHandler,
  createPrismaIncidentSink,
} from "../services/canonical-deposit-verifier.js";
import type {
  ChainRegistry,
  QuorumReader,
  RegistryIncidentEvidence,
  RegistryLogger,
} from "../services/chain-registry.js";

export const CANONICAL_DEPOSIT_MONITOR_QUEUE = "canonical-deposit-monitor";
export const CANONICAL_DEPOSIT_DEFAULT_INTERVAL_MS = 30_000;

export interface MonitorRegistry extends QuorumReader {
  freezeChain(chainId: number, evidence: RegistryIncidentEvidence): Promise<void>;
}

export interface CanonicalDepositMonitorDeps {
  prisma: Pick<PrismaClient, "depositClaimRecord" | "asset">;
  registry: MonitorRegistry;
  intents: Pick<FinancialIntentService, "recordDepositReorg">;
  incidents: Pick<FinancialIncidentService, "freezeAsset">;
  logger?: RegistryLogger;
  limit?: number;
}

export interface CanonicalDepositMonitorResult {
  checked: number;
  /** Claims that reached (or were already at) deep finality this pass. */
  deepFinalized: number;
  reorged: number;
  /** Claims left untouched because quorum was unavailable or data was missing. */
  preserved: number;
}

/**
 * One monitoring pass. Safe to run concurrently with itself: the reorg path is
 * idempotent in the finance core (`recordDepositReorg` returns the existing
 * incident) and status transitions are guarded.
 */
export async function runCanonicalDepositMonitorOnce(
  deps: CanonicalDepositMonitorDeps
): Promise<CanonicalDepositMonitorResult> {
  const limit = deps.limit ?? 100;
  const claims = await deps.prisma.depositClaimRecord.findMany({
    where: { status: "CREDITED" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const result: CanonicalDepositMonitorResult = {
    checked: claims.length,
    deepFinalized: 0,
    reorged: 0,
    preserved: 0,
  };

  for (const claim of claims) {
    const asset = await deps.prisma.asset.findUnique({
      where: { id: claim.assetId },
      select: { id: true, chainId: true, deepFinality: true },
    });
    if (!asset || !claim.blockNumber) {
      result.preserved += 1;
      continue;
    }

    let head: bigint;
    let block;
    try {
      head = await deps.registry.getSettlementBlockNumber(asset.chainId);
      block = await deps.registry.getBlock(asset.chainId, {
        blockNumber: BigInt(claim.blockNumber),
      });
    } catch (error) {
      // Quorum/lost-RPC failure: no reorg conclusion, preserve and retry.
      deps.logger?.warn(
        { claimId: claim.id, error: error instanceof Error ? error.message : String(error) },
        "Canonical deposit monitor could not verify claim; preserving status"
      );
      result.preserved += 1;
      continue;
    }

    const storedBlockHash = (claim.blockHash ?? "").toLowerCase();
    if (block.hash !== storedBlockHash) {
      const evidence: RegistryIncidentEvidence = {
        chainId: asset.chainId,
        method: "DEPOSIT_REORG",
        reason: "block_hash_mismatch",
        endpoints: [
          { id: "credited", endpoint: "internal", ok: true, fingerprint: storedBlockHash },
          { id: "canonical", endpoint: "internal", ok: true, fingerprint: block.hash },
        ],
      };

      await deps.intents.recordDepositReorg({
        claimId: claim.id,
        blockNumber: block.number.toString(),
        evidence: {
          storedBlockHash,
          canonicalBlockHash: block.hash,
          observedBlockNumber: block.number.toString(),
          source: "canonical-deposit-monitor",
        },
      });
      await deps.registry.freezeChain(asset.chainId, evidence);
      await deps.incidents.freezeAsset(asset.id);
      result.reorged += 1;

      deps.logger?.error(
        {
          event: "canonical_deposit_reorg",
          claimId: claim.id,
          assetId: asset.id,
          storedBlockHash,
          canonicalBlockHash: block.hash,
        },
        "Canonical deposit reorg recorded; user liability preserved"
      );
      continue;
    }

    // Inclusive depth: the credited block counts as the first confirmation.
    const confirmations = Number(head) - Number(claim.blockNumber) + 1;
    const safeConfirmations = confirmations < 0 ? 0 : confirmations;
    if (safeConfirmations !== claim.confirmations) {
      await deps.prisma.depositClaimRecord.update({
        where: { id: claim.id },
        data: { confirmations: safeConfirmations },
      });
    }
    if (safeConfirmations >= asset.deepFinality) result.deepFinalized += 1;
  }

  return result;
}

export function createCanonicalDepositMonitorWorker(
  logger: RegistryLogger,
  deps: CanonicalDepositMonitorDeps,
  redis: Redis
): Worker {
  const worker = new Worker(
    CANONICAL_DEPOSIT_MONITOR_QUEUE,
    async (_job: Job) => {
      const result = await runCanonicalDepositMonitorOnce({ ...deps, logger });
      logger.info({ ...result }, "Canonical deposit monitor pass completed");
      return result;
    },
    { connection: redis }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Canonical deposit monitor job failed");
  });

  return worker;
}

export interface BootstrapCanonicalDepositMonitorOptions {
  prisma: PrismaClient;
  redis: Redis;
  logger: RegistryLogger;
  intervalMs?: number;
  limit?: number;
}

export interface BootstrappedCanonicalDepositMonitor {
  registry: ChainRegistry;
  intents: FinancialIntentService;
  incidents: FinancialIncidentService;
  worker: Worker;
  queue: Queue;
}

/**
 * Full startup for the canonical deposit monitor. Builds the registry from the
 * assets' configured RPC endpoints (at least two per chain), persists RPC
 * incidents, freezes assets on registry freeze, starts the BullMQ worker and
 * schedules a repeatable pass.
 */
export async function bootstrapCanonicalDepositMonitor(
  options: BootstrapCanonicalDepositMonitorOptions
): Promise<BootstrappedCanonicalDepositMonitor> {
  const ledger = new AtomicLedger(options.prisma);
  const intents = new FinancialIntentService(options.prisma, ledger);
  const incidents = new FinancialIncidentService(options.prisma, ledger);

  const registry = await buildChainRegistryFromAssets(options.prisma, {
    logger: options.logger,
    incidentSink: createPrismaIncidentSink(options.prisma),
    onFreeze: createPrismaChainFreezeHandler(options.prisma),
  });

  const worker = createCanonicalDepositMonitorWorker(
    options.logger,
    {
      prisma: options.prisma,
      registry,
      intents,
      incidents,
      logger: options.logger,
      limit: options.limit,
    },
    options.redis
  );

  const queue = new Queue(CANONICAL_DEPOSIT_MONITOR_QUEUE, { connection: options.redis });
  await queue.upsertJobScheduler(
    `${CANONICAL_DEPOSIT_MONITOR_QUEUE}-singleton`,
    { every: options.intervalMs ?? CANONICAL_DEPOSIT_DEFAULT_INTERVAL_MS },
    { name: CANONICAL_DEPOSIT_MONITOR_QUEUE, data: {} }
  );

  return { registry, intents, incidents, worker, queue };
}
