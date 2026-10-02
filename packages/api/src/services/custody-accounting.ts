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
 *
 * `expectedTreasuryAtomic` is the signed net of every account class except the
 * external counterparty (`TREASURY_RESERVE`), read under a stable
 * `Asset.ledgerVersion` fence so a concurrent post cannot produce a torn sum.
 */

import type { PrismaClient } from "../../generated/prisma/index.js";
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

export interface CustodyReconciliationEvidence {
  assetId: string;
  chainId: number;
  treasuryAddress: string;
  custodyAtomic: string;
  expectedAtomic: string;
  observations: Array<{ rpcUrl: string; valueAtomic: string }>;
  observedAt: number;
  mismatch: boolean;
}

export interface CustodyTreasuryAccounting {
  completeWithdrawal(record: CustodyAccountingRecord): Promise<{ journalId: string }>;
  recordObligation(
    record: CustodyAccountingRecord,
    incident: CustodyAccountingIncident
  ): Promise<{ journalId: string }>;
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

        await ledger.lockAsset(tx, assetId);
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

    async recordObligation(record) {
      const assetId = AssetIdSchema.parse(record.assetId);
      return runTransactionWithRetry(prisma, async (tx) => {
        const row = await tx.withdrawalIntentRecord.findUnique({
          where: { id: record.intentId },
        });
        if (!row) throw new LedgerInvariantError("Unknown withdrawal intent");
        if (row.assetId !== assetId) {
          throw new LedgerInvariantError("Withdrawal asset does not match the journal asset");
        }
        if (row.reorgJournalId) {
          return { journalId: row.reorgJournalId };
        }

        // The obligation only restores value that was already moved out by the
        // settlement journal. Refuse to post it unless that journal exists,
        // even if the intent's `CONFIRMED` state raced ahead of completion.
        const settle = await ledger.readJournal(tx, SETTLE_REQUEST(row.id));
        if (!settle) {
          throw new LedgerInvariantError(
            "Cannot record a withdrawal obligation before settlement completes"
          );
        }
        if (!row.confirmedJournalId) {
          await tx.withdrawalIntentRecord.updateMany({
            where: { id: row.id, confirmedJournalId: null },
            data: { confirmedJournalId: settle.id },
          });
        }

        await ledger.lockAsset(tx, assetId);
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
          requestId: REORG_REQUEST(row.id),
          assetId,
          postings: [
            { accountId: obligation.accountId, amountAtomic: row.amountAtomic },
            { accountId: treasury.accountId, amountAtomic: `-${row.amountAtomic}` },
          ],
        });

        await tx.withdrawalIntentRecord.updateMany({
          where: { id: row.id, reorgJournalId: null },
          data: { reorgJournalId: journal.id },
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
        evidence: {
          treasuryAddress: evidence.treasuryAddress,
          observations: evidence.observations,
          observedAt: evidence.observedAt,
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
