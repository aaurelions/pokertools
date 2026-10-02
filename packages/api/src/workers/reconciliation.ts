import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { AtomicLedger, LedgerInvariantError } from "../services/atomic-ledger.js";
import type { PrismaClient } from "../../generated/prisma/index.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const logger = pino({ name: "reconciliation" });

/**
 * Stable machine codes emitted by reconciliation. Log consumers should key off
 * these codes rather than human-readable messages. No raw credentials, secrets
 * or endpoints are ever included in a reconciliation log line.
 */
export const RECONCILIATION_CODES = {
  IDEMPOTENCY_CLEANUP_FAILED: "RECON_IDEMPOTENCY_CLEANUP_FAILED",
  SESSION_CLEANUP_FAILED: "RECON_SESSION_CLEANUP_FAILED",
  CHIP_BALANCE_MISMATCH: "RECON_CHIP_BALANCE_MISMATCH",
  CHIP_CHECK_ERROR: "RECON_CHIP_CHECK_ERROR",
  ATOMIC_LEDGER_UNBALANCED: "RECON_ATOMIC_LEDGER_UNBALANCED",
  ATOMIC_CHECK_ERROR: "RECON_ATOMIC_CHECK_ERROR",
} as const;

export interface ReconciliationResult {
  idempotencyRecordsDeleted: number;
  sessionsDeleted: number;
  chipAccountsChecked: number;
  chipMismatches: number;
  chipErrors: number;
  assetsChecked: number;
  assetMismatches: number;
  assetErrors: number;
}

/** Minimal logging surface so the check functions are unit-testable. */
export interface ReconciliationLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Verify the cached `ChipAccount.balance` projection equals the sum of its
 * append-only `ChipLedgerEntry` journal. Reports (never repairs) divergences.
 */
export async function checkChipJournalInvariants(
  client: PrismaClient,
  logger: ReconciliationLogger,
  limit = config.RECONCILIATION_BATCH_SIZE
): Promise<{ checked: number; mismatches: number; errors: number }> {
  const accounts = await client.chipAccount.findMany({
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true, principalId: true, kind: true, balance: true },
  });

  let mismatches = 0;
  let errors = 0;

  for (const account of accounts) {
    try {
      const sum = await client.chipLedgerEntry.aggregate({
        where: { accountId: account.id },
        _sum: { amount: true },
      });
      const journalSum = sum._sum.amount ?? 0n;
      if (journalSum !== account.balance) {
        mismatches += 1;
        logger.warn(
          {
            code: RECONCILIATION_CODES.CHIP_BALANCE_MISMATCH,
            accountId: account.id,
            principalId: account.principalId,
            kind: account.kind,
            projectedBalance: account.balance.toString(),
            journalSum: journalSum.toString(),
          },
          "Chip account projection diverged from its journal"
        );
      }
    } catch (error) {
      errors += 1;
      logger.error(
        {
          code: RECONCILIATION_CODES.CHIP_CHECK_ERROR,
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to check chip account journal"
      );
    }
  }

  return { checked: accounts.length, mismatches, errors };
}

/**
 * Verify every asset's atomic journal is balanced and that each cached
 * `AtomicAccount` projection matches its postings, using the canonical
 * `AtomicLedger.assertAssetBalanced` invariant. Reports, never repairs.
 */
export async function checkAtomicLedgerInvariants(
  client: PrismaClient,
  logger: ReconciliationLogger,
  limit = config.RECONCILIATION_BATCH_SIZE
): Promise<{ checked: number; mismatches: number; errors: number }> {
  const ledger = new AtomicLedger(client);
  const assets = await client.asset.findMany({
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });

  let mismatches = 0;
  let errors = 0;

  for (const asset of assets) {
    try {
      await ledger.assertAssetBalanced(client, asset.id);
    } catch (error) {
      // A LedgerInvariantError means an actual accounting break; any other
      // error is reported separately so operators can distinguish a transient
      // read failure from a genuine imbalance. Both are reported only.
      const code =
        error instanceof LedgerInvariantError
          ? RECONCILIATION_CODES.ATOMIC_LEDGER_UNBALANCED
          : RECONCILIATION_CODES.ATOMIC_CHECK_ERROR;
      if (code === RECONCILIATION_CODES.ATOMIC_LEDGER_UNBALANCED) mismatches += 1;
      else errors += 1;
      logger.error(
        {
          code,
          assetId: asset.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Atomic ledger invariant check failed"
      );
    }
  }

  return { checked: assets.length, mismatches, errors };
}

/**
 * Run one full reconciliation pass:
 * 1. delete expired idempotency records,
 * 2. delete expired sessions,
 * 3. verify chip journal/projection invariants,
 * 4. verify atomic ledger/journal invariants.
 *
 * Never mutates ledger or chip state: a divergence is logged for an operator.
 */
export async function runReconciliationOnce(
  client: PrismaClient,
  logger: ReconciliationLogger,
  limit = config.RECONCILIATION_BATCH_SIZE
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    idempotencyRecordsDeleted: 0,
    sessionsDeleted: 0,
    chipAccountsChecked: 0,
    chipMismatches: 0,
    chipErrors: 0,
    assetsChecked: 0,
    assetMismatches: 0,
    assetErrors: 0,
  };

  try {
    const deleted = await client.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    result.idempotencyRecordsDeleted = deleted.count;
  } catch (error) {
    logger.error(
      {
        code: RECONCILIATION_CODES.IDEMPOTENCY_CLEANUP_FAILED,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to clean up expired idempotency records"
    );
  }

  try {
    const deleted = await client.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    result.sessionsDeleted = deleted.count;
  } catch (error) {
    logger.error(
      {
        code: RECONCILIATION_CODES.SESSION_CLEANUP_FAILED,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to clean up expired sessions"
    );
  }

  try {
    const chip = await checkChipJournalInvariants(client, logger, limit);
    result.chipAccountsChecked = chip.checked;
    result.chipMismatches = chip.mismatches;
    result.chipErrors = chip.errors;
  } catch (error) {
    // A scan-level read failure must not abort the other invariant checks.
    logger.error(
      {
        code: RECONCILIATION_CODES.CHIP_CHECK_ERROR,
        scope: "scan",
        error: error instanceof Error ? error.message : String(error),
      },
      "Chip journal reconciliation scan failed"
    );
  }

  try {
    const atomic = await checkAtomicLedgerInvariants(client, logger, limit);
    result.assetsChecked = atomic.checked;
    result.assetMismatches = atomic.mismatches;
    result.assetErrors = atomic.errors;
  } catch (error) {
    logger.error(
      {
        code: RECONCILIATION_CODES.ATOMIC_CHECK_ERROR,
        scope: "scan",
        error: error instanceof Error ? error.message : String(error),
      },
      "Atomic ledger reconciliation scan failed"
    );
  }

  logger.info({ ...result }, "Reconciliation pass complete");
  return result;
}

/**
 * Reconciliation & Cleanup Worker
 *
 * Periodic maintenance tasks:
 * 1. Canonical chip journal vs `ChipAccount.balance` invariant
 * 2. Canonical atomic journal balance + projection invariant per asset
 * 3. Expired idempotency record cleanup
 * 4. Expired session cleanup
 *
 * The legacy Account/LedgerEntry sampling was replaced by the canonical
 * invariants. This worker only observes and logs; it never repairs balances.
 */
const reconciliationWorker = new Worker(
  "reconciliation",
  async () => {
    logger.info("Reconciliation worker started");
    await runReconciliationOnce(prisma, logger);
  },
  { connection: redis as any }
);

reconciliationWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "reconciliation job failed");
});

export default reconciliationWorker;
