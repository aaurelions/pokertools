/**
 * API-owned treasury accounting adapter for the isolated custody workflow.
 *
 * Custody owns the withdrawal lifecycle (CAS states CONFIRMED/FINALIZED/
 * REORGED). This adapter deliberately touches the canonical journal and the
 * intent's journal-id columns ONLY; it never sets or clears `state`, so a
 * ledger-side completion/obligation can never clobber a custody decision.
 *
 * Journal semantics (canonical, balanced, immutable):
 *  - confirmation: PENDING_WITHDRAWAL `-a`, TREASURY_RESERVE `+a`
 *  - post-completion reorg obligation: INCIDENT_OBLIGATION `+a`,
 *    TREASURY_RESERVE `-a`
 *  - same-payout re-inclusion reversal: INCIDENT_OBLIGATION `-a`,
 *    TREASURY_RESERVE `+a` (never a second settlement or refund)
 *
 * Every reorg-cycle mutation takes the durable per-asset lock BEFORE reading
 * the intent row or cycle journals (consistent asset-first order). Obligations
 * and reversals are bound to the durable state/receipt identity they observed,
 * and the journal + pointer CAS commit or roll back together: a losing pointer
 * CAS aborts the transaction and retries fresh state instead of committing an
 * unpointed liability.
 *
 * `expectedTreasuryAtomic` is the signed net of every account class except the
 * external counterparty (`TREASURY_RESERVE`), read under a stable
 * `Asset.ledgerVersion` fence so a concurrent post cannot produce a torn sum.
 */

import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import { AssetIdSchema } from "@pokertools/types";
import {
  AtomicLedger,
  ConcurrentLedgerModificationError,
  LedgerInvariantError,
  parseSignedAtomic,
  runTransactionWithRetry,
} from "./atomic-ledger.js";
import { FinancialIncidentService } from "./financial-incidents.js";

// ---------------------------------------------------------------------------
// Structural contracts (mirror the custody accounting port)
// ---------------------------------------------------------------------------

export interface CustodyAccountingRecord {
  intentId: string;
  principalId: string;
  assetId: string;
  chainId: number;
  amountAtomic: string;
  destination?: string;
  txHash?: string | null;
  treasuryNonce?: number | null;
}

export interface CustodyAccountingIncident {
  incidentId: string;
  kind?: string;
  detail?: Record<string, unknown>;
}

/** Durable evidence binding a reversal to the re-included exact payout. */
export interface CustodyReorgReversalEvidence {
  txHash: string;
  receiptBlockNumber: string;
  receiptBlockHash: string;
}

/** Durable evidence binding an obligation to the reorged inclusion. */
export interface CustodyReorgObligationEvidence {
  txHash: string;
  priorReceiptBlockNumber: string;
  priorReceiptBlockHash: string;
}

export interface CustodyReconciliationEvidence {
  assetId: string;
  chainId: number;
  treasuryAddress: string;
  custodyAtomic: string;
  expectedAtomic: string;
  blockNumber: string;
  blockHash: string;
  observations: Array<{ rpcUrl: string; valueAtomic: string }>;
  observedAt: number;
  mismatch: boolean;
}

export interface CustodyTreasuryAccounting {
  completeWithdrawal(record: CustodyAccountingRecord): Promise<{ journalId: string }>;
  recordObligation(
    record: CustodyAccountingRecord,
    incident: CustodyAccountingIncident,
    evidence: CustodyReorgObligationEvidence
  ): Promise<{ journalId: string | null }>;
  reverseObligation(
    record: CustodyAccountingRecord,
    evidence: CustodyReorgReversalEvidence
  ): Promise<{ journalId: string | null }>;
  recordReconciliation(evidence: CustodyReconciliationEvidence): Promise<{ journalId: string }>;
  expectedTreasuryAtomic(assetId: string): Promise<string>;
}

export interface CustodyAccountingOptions {
  prisma: PrismaClient;
  ledger?: AtomicLedger;
  incidents?: FinancialIncidentService;
}

const SETTLE_REQUEST = (intentId: string) => `withdrawal-settle:${intentId}`;
const REORG_REQUEST = (intentId: string) => `withdrawal-reorg:${intentId}`;
/**
 * A reorg cycle after a previous obligation was reversed is keyed off that
 * reversal's journal id, so obligation request ids can never collide across
 * repeat reorg cycles while the first cycle keeps the canonical legacy key.
 */
const REORG_REQUEST_AFTER_REVERSAL = (intentId: string, reversalJournalId: string) =>
  `withdrawal-reorg:${intentId}:after:${reversalJournalId}`;
const REORG_REVERSAL_REQUEST = (obligationJournalId: string) =>
  `withdrawal-reorg-reverse:${obligationJournalId}`;

const REORG_CYCLE_ATTEMPTS = 5;

/**
 * Marker for a lost reorg-cycle pointer compare-and-set. The transaction that
 * posted the journal is aborted (the journal rolls back with it) and the whole
 * cycle operation is retried against fresh durable state.
 */
class ReorgCycleConflictError extends Error {
  constructor() {
    super("Reorg cycle pointer CAS lost");
    this.name = "ReorgCycleConflictError";
  }
}

/**
 * Run a reorg-cycle transaction, retrying pointer-CAS conflicts at the OUTER
 * boundary so a loser never commits an unpointed obligation. Exhausted retries
 * surface as a concurrent-modification error for the caller to fail closed on.
 */
async function runCycleTransaction<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= REORG_CYCLE_ATTEMPTS; attempt += 1) {
    try {
      return await runTransactionWithRetry(prisma, work);
    } catch (error) {
      if (!(error instanceof ReorgCycleConflictError)) throw error;
      if (attempt === REORG_CYCLE_ATTEMPTS) {
        throw new ConcurrentLedgerModificationError("Reorg cycle pointer conflicted");
      }
    }
  }
  throw new ConcurrentLedgerModificationError("Reorg cycle pointer conflicted");
}

/**
 * Asset-first lock order: every authoritative financial mutation for an asset
 * takes the durable asset lock BEFORE reading the withdrawal row or any cycle
 * journal, so obligation/reversal/settlement decisions for one asset are
 * serialized and never made from a torn read.
 */
async function lockAssetAndLoadRow(
  tx: Prisma.TransactionClient,
  ledger: AtomicLedger,
  assetId: string,
  intentId: string
) {
  const locked = await ledger.lockAsset(tx, assetId);
  if (!locked) throw new LedgerInvariantError("Unknown asset for journal transaction");
  const row = await tx.withdrawalIntentRecord.findUnique({ where: { id: intentId } });
  if (!row) throw new LedgerInvariantError("Unknown withdrawal intent");
  if (row.assetId !== assetId) {
    throw new LedgerInvariantError("Withdrawal asset does not match the journal asset");
  }
  return row;
}

/** Map an immutable journal's postings to `class -> signed amount`. */
async function postingsByClass(
  tx: Prisma.TransactionClient,
  postings: Array<{ accountId: string; amountAtomic: string }>
): Promise<Map<string, string>> {
  const accounts = await tx.atomicAccount.findMany({
    where: { id: { in: postings.map((posting) => posting.accountId) } },
    select: { id: true, class: true },
  });
  const classByAccount = new Map(accounts.map((account) => [account.id, account.class]));
  const byClass = new Map<string, string>();
  for (const posting of postings) {
    const accountClass = classByAccount.get(posting.accountId);
    if (!accountClass) {
      throw new LedgerInvariantError("Journal references an unknown account");
    }
    byClass.set(accountClass, posting.amountAtomic);
  }
  return byClass;
}

/**
 * Verify the exact persisted original settlement journal for this intent:
 * asset match, `confirmedJournalId` agreement, and the exact
 * PENDING_WITHDRAWAL `-a` / TREASURY_RESERVE `+a` postings. Existence alone is
 * never enough to restore or reverse an obligation.
 */
async function assertSettlementJournal(
  tx: Prisma.TransactionClient,
  ledger: AtomicLedger,
  row: { id: string; amountAtomic: string; confirmedJournalId: string | null },
  assetId: string
) {
  const settle = await ledger.readJournal(tx, SETTLE_REQUEST(row.id));
  if (!settle) {
    throw new LedgerInvariantError(
      "Cannot record a withdrawal obligation before settlement completes"
    );
  }
  if (settle.assetId !== assetId || settle.postings.length !== 2) {
    throw new LedgerInvariantError("Settlement journal is malformed");
  }
  if (row.confirmedJournalId !== null && row.confirmedJournalId !== settle.id) {
    throw new LedgerInvariantError(
      "Settlement journal does not match the intent's confirmed journal id"
    );
  }
  const byClass = await postingsByClass(tx, settle.postings);
  if (
    byClass.get("PENDING_WITHDRAWAL") !== `-${row.amountAtomic}` ||
    byClass.get("TREASURY_RESERVE") !== row.amountAtomic
  ) {
    throw new LedgerInvariantError("Settlement journal does not match the withdrawal amount");
  }
  return settle;
}

/**
 * Build the real API-side accounting port. Idempotent on the canonical journal
 * `requestId`, so a custody retry after a crash cannot double-post.
 */
export function createCustodyAccounting(
  options: CustodyAccountingOptions
): CustodyTreasuryAccounting {
  const { prisma } = options;
  const ledger = options.ledger ?? new AtomicLedger(prisma);
  const incidents = options.incidents ?? new FinancialIncidentService(prisma, ledger);

  return {
    async completeWithdrawal(record) {
      const assetId = AssetIdSchema.parse(record.assetId);
      return runTransactionWithRetry(prisma, async (tx) => {
        // Asset-first lock order, same as the reorg-cycle mutations: take the
        // durable asset lock before reading the intent row.
        const locked = await ledger.lockAsset(tx, assetId);
        if (!locked) throw new LedgerInvariantError("Unknown asset for journal transaction");
        const row = await tx.withdrawalIntentRecord.findUnique({
          where: { id: record.intentId },
        });
        if (!row) throw new LedgerInvariantError("Unknown withdrawal intent");
        if (row.assetId !== assetId) {
          throw new LedgerInvariantError("Withdrawal asset does not match the journal asset");
        }
        if (row.confirmedJournalId) {
          return { journalId: row.confirmedJournalId };
        }

        const pending = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: row.principalId,
          class: "PENDING_WITHDRAWAL",
        });
        const treasury = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: null,
          class: "TREASURY_RESERVE",
        });

        const journal = await ledger.post(tx, {
          requestId: SETTLE_REQUEST(row.id),
          assetId,
          postings: [
            { accountId: pending.accountId, amountAtomic: `-${row.amountAtomic}` },
            { accountId: treasury.accountId, amountAtomic: row.amountAtomic },
          ],
        });

        // Journal id only. `state` is owned by the custody compare-and-set.
        await tx.withdrawalIntentRecord.updateMany({
          where: { id: row.id, confirmedJournalId: null },
          data: { confirmedJournalId: journal.id },
        });
        return { journalId: journal.id };
      });
    },

    async recordObligation(record, _incident, evidence) {
      const assetId = AssetIdSchema.parse(record.assetId);
      return runCycleTransaction(prisma, async (tx) => {
        // Asset-first lock order: serialize every financial decision for this
        // asset BEFORE reading the withdrawal row or cycle journals.
        const row = await lockAssetAndLoadRow(tx, ledger, assetId, record.intentId);

        // Bind the obligation to the exact durable reorg cycle the caller
        // observed. If the record moved on (payout re-included, state advanced)
        // or the caller's snapshot is stale, post nothing.
        if (
          !row.txHash ||
          row.txHash.toLowerCase() !== evidence.txHash.toLowerCase() ||
          row.state !== "REORGED" ||
          row.receiptBlockHash === null ||
          row.receiptBlockNumber === null ||
          row.receiptBlockHash.toLowerCase() !== evidence.priorReceiptBlockHash.toLowerCase() ||
          row.receiptBlockNumber !== evidence.priorReceiptBlockNumber
        ) {
          return { journalId: null };
        }

        // The obligation only restores value already moved out by the exact
        // original settlement journal (asset, amount and postings verified).
        const settle = await assertSettlementJournal(tx, ledger, row, assetId);
        if (!row.confirmedJournalId) {
          await tx.withdrawalIntentRecord.updateMany({
            where: { id: row.id, confirmedJournalId: null },
            data: { confirmedJournalId: settle.id },
          });
        }

        // Cycle-aware idempotency: an unreversed obligation is the current one;
        // a reversed one means a new reorg cycle and is chained off the
        // reversal journal id so it can never replay the reversed journal.
        let requestId = REORG_REQUEST(row.id);
        let expectedPointer: string | null = null;
        if (row.reorgJournalId) {
          const reversal = await ledger.readJournal(tx, REORG_REVERSAL_REQUEST(row.reorgJournalId));
          if (!reversal) return { journalId: row.reorgJournalId };
          requestId = REORG_REQUEST_AFTER_REVERSAL(row.id, reversal.id);
          expectedPointer = row.reorgJournalId;
        }

        const obligation = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: null,
          class: "INCIDENT_OBLIGATION",
        });
        const treasury = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: null,
          class: "TREASURY_RESERVE",
        });

        const journal = await ledger.post(tx, {
          requestId,
          assetId,
          postings: [
            { accountId: obligation.accountId, amountAtomic: row.amountAtomic },
            { accountId: treasury.accountId, amountAtomic: `-${row.amountAtomic}` },
          ],
        });

        // Commit the pointer and the journal atomically, and only while the
        // durable row still shows this exact cycle. A lost CAS aborts the
        // transaction (rolling the journal back) and retries fresh state, so a
        // loser can never leave an unpointed new liability committed.
        const updated = await tx.withdrawalIntentRecord.updateMany({
          where: {
            id: row.id,
            reorgJournalId: expectedPointer,
            state: "REORGED",
            receiptBlockNumber: row.receiptBlockNumber,
            receiptBlockHash: row.receiptBlockHash,
          },
          data: { reorgJournalId: journal.id },
        });
        if (updated.count === 0) throw new ReorgCycleConflictError();
        return { journalId: journal.id };
      });
    },

    async reverseObligation(record, evidence) {
      const assetId = AssetIdSchema.parse(record.assetId);
      return runTransactionWithRetry(prisma, async (tx) => {
        // Asset-first lock order (same as recordObligation).
        const row = await lockAssetAndLoadRow(tx, ledger, assetId, record.intentId);
        if (!row.confirmedJournalId) {
          throw new LedgerInvariantError(
            "Cannot reverse a withdrawal obligation before settlement completes"
          );
        }
        // Verify the exact persisted original settlement journal, not just its
        // existence.
        await assertSettlementJournal(tx, ledger, row, assetId);

        // Durable evidence binding: only the exact persisted payout bytes may
        // reverse an obligation, and the canonical receipt identity must be
        // recorded by the caller.
        if (!row.txHash || row.txHash.toLowerCase() !== evidence.txHash.toLowerCase()) {
          throw new LedgerInvariantError(
            "Reorg reversal does not match the persisted payout transaction hash"
          );
        }
        if (!evidence.receiptBlockHash || !evidence.receiptBlockNumber) {
          throw new LedgerInvariantError(
            "Reorg reversal requires the re-included receipt block identity"
          );
        }

        // The payout must be present and finalizing: a record that reorged away
        // again (REORGED) or an advanced/mismatched receipt must never reverse.
        if (row.state !== "PENDING_CONFIRMATION" && row.state !== "CONFIRMED") {
          return { journalId: null };
        }
        if (
          row.receiptBlockHash === null ||
          row.receiptBlockNumber === null ||
          row.receiptBlockHash.toLowerCase() !== evidence.receiptBlockHash.toLowerCase() ||
          row.receiptBlockNumber !== evidence.receiptBlockNumber
        ) {
          return { journalId: null };
        }

        const obligationJournalId = row.reorgJournalId;
        if (!obligationJournalId) return { journalId: null };

        // Verify the obligation journal is the exact INCIDENT_OBLIGATION +a /
        // TREASURY_RESERVE -a pair for this withdrawal before reversing it.
        const obligationJournal = await tx.journalTransaction.findUnique({
          where: { id: obligationJournalId },
          include: { postings: true },
        });
        if (
          !obligationJournal ||
          obligationJournal.assetId !== assetId ||
          obligationJournal.postings.length !== 2
        ) {
          throw new LedgerInvariantError("Reorg obligation journal is missing or malformed");
        }
        const amountByClass = await postingsByClass(tx, obligationJournal.postings);
        if (
          amountByClass.get("INCIDENT_OBLIGATION") !== row.amountAtomic ||
          amountByClass.get("TREASURY_RESERVE") !== `-${row.amountAtomic}`
        ) {
          throw new LedgerInvariantError(
            "Reorg obligation journal does not match the withdrawal amount"
          );
        }

        const obligation = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: null,
          class: "INCIDENT_OBLIGATION",
        });
        const treasury = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: null,
          class: "TREASURY_RESERVE",
        });

        // Idempotent per outstanding obligation journal. `reorgJournalId` is
        // intentionally retained: it is the durable pointer for the next cycle.
        const journal = await ledger.post(tx, {
          requestId: REORG_REVERSAL_REQUEST(obligationJournalId),
          assetId,
          postings: [
            { accountId: obligation.accountId, amountAtomic: `-${row.amountAtomic}` },
            { accountId: treasury.accountId, amountAtomic: row.amountAtomic },
          ],
        });
        return { journalId: journal.id };
      });
    },

    async recordReconciliation(evidence) {
      // On mismatch the custody workflow raises TREASURY_SHORTFALL and freezes
      // the route; this call persists the durable signed evidence row.
      const reconciliation = await incidents.recordReconciliation({
        assetId: evidence.assetId,
        chainId: evidence.chainId,
        observedAtomic: evidence.custodyAtomic,
        ledgerAtomic: evidence.expectedAtomic,
        blockNumber: evidence.blockNumber,
        evidence: {
          treasuryAddress: evidence.treasuryAddress,
          observations: evidence.observations,
          observedAt: evidence.observedAt,
          blockHash: evidence.blockHash,
          mismatch: evidence.mismatch,
        },
      });
      return { journalId: reconciliation.id };
    },

    async expectedTreasuryAtomic(assetId) {
      const parsedAssetId = AssetIdSchema.parse(assetId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await prisma.asset.findUnique({
          where: { id: parsedAssetId },
          select: { ledgerVersion: true },
        });
        if (!before) throw new LedgerInvariantError("Unknown asset");

        const accounts = await prisma.atomicAccount.findMany({
          where: { assetId: parsedAssetId },
          select: { class: true, balanceAtomic: true },
        });

        const after = await prisma.asset.findUnique({
          where: { id: parsedAssetId },
          select: { ledgerVersion: true },
        });
        if (after && after.ledgerVersion === before.ledgerVersion) {
          let total = 0n;
          for (const account of accounts) {
            if (account.class === "TREASURY_RESERVE") continue;
            total += parseSignedAtomic(account.balanceAtomic);
          }
          return total.toString();
        }
      }
      throw new ConcurrentLedgerModificationError(
        "Asset ledger changed while reading expected treasury balance"
      );
    },
  };
}
