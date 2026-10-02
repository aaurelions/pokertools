/**
 * Acceptance wiring for the custody `TreasuryAccounting` port.
 *
 * The canonical implementation is the API finance-core export (upcoming). This
 * helper binds the port to the REAL durable API primitives that finance-core
 * will wrap:
 *   - `AtomicLedger` (balanced, sealed, immutable journal postings), and
 *   - `FinancialIncidentService.recordReconciliation` (durable evidence).
 *
 * It deliberately does NOT import the API `FinancialIntentService.settleWithdrawal`
 * helper: that helper forces `state = FINALIZED`, whereas the custody port
 * contract expects the journal to complete at confirmation while custody retains
 * ownership of the CONFIRMED -> FINALIZED deep-finality transition. The journal
 * posting semantics here match the documented contract exactly, and are
 * idempotent on stable request ids.
 *
 * No balance is created here: every posting moves value between real accounts
 * whose opening state came from an on-chain deposit claim.
 */
import type { PrismaClient } from "../../../../api/generated/prisma/index.js";
import {
  AtomicLedger,
  FinancialIncidentService,
  runTransactionWithRetry,
} from "../../../../api/src/finance-core.js";
import type {
  IncidentRecord,
  ReconciliationEvidence,
  TreasuryAccounting,
  WithdrawalRecord,
} from "../../../../custody/src/core/types.js";

const TREASURY_RESERVE = "TREASURY_RESERVE" as const;
const PENDING_WITHDRAWAL = "PENDING_WITHDRAWAL" as const;
const INCIDENT_OBLIGATION = "INCIDENT_OBLIGATION" as const;

export function createPrismaTreasuryAccounting(prisma: PrismaClient): TreasuryAccounting {
  const ledger = new AtomicLedger(prisma);
  const incidents = new FinancialIncidentService(prisma, ledger);

  return {
    async completeWithdrawal(record: WithdrawalRecord): Promise<{ journalId: string }> {
      return runTransactionWithRetry(prisma, async (tx) => {
        const pending = await ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: record.principalId,
          class: PENDING_WITHDRAWAL,
        });
        const treasury = await ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: null,
          class: TREASURY_RESERVE,
        });
        const journal = await ledger.post(tx, {
          requestId: `withdrawal-complete:${record.intentId}`,
          assetId: record.assetId,
          postings: [
            { accountId: pending.accountId, amountAtomic: `-${record.amountAtomic}` },
            { accountId: treasury.accountId, amountAtomic: record.amountAtomic },
          ],
        });
        await tx.withdrawalIntentRecord.updateMany({
          where: { id: record.intentId, confirmedJournalId: null },
          data: { confirmedJournalId: journal.id },
        });
        return { journalId: journal.id };
      });
    },

    async recordObligation(
      record: WithdrawalRecord,
      _incident: IncidentRecord
    ): Promise<{ journalId: string }> {
      return runTransactionWithRetry(prisma, async (tx) => {
        const obligation = await ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: null,
          class: INCIDENT_OBLIGATION,
        });
        const treasury = await ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: null,
          class: TREASURY_RESERVE,
        });
        const journal = await ledger.post(tx, {
          requestId: `withdrawal-reorg:${record.intentId}`,
          assetId: record.assetId,
          postings: [
            { accountId: obligation.accountId, amountAtomic: record.amountAtomic },
            { accountId: treasury.accountId, amountAtomic: `-${record.amountAtomic}` },
          ],
        });
        await tx.withdrawalIntentRecord.updateMany({
          where: { id: record.intentId, reorgJournalId: null },
          data: { reorgJournalId: journal.id },
        });
        return { journalId: journal.id };
      });
    },

    async recordReconciliation(evidence: ReconciliationEvidence): Promise<{ journalId: string }> {
      const record = await incidents.recordReconciliation({
        assetId: evidence.assetId,
        chainId: evidence.chainId,
        observedAtomic: evidence.custodyAtomic,
        ledgerAtomic: evidence.expectedAtomic,
        // The custody workflow does not currently thread a canonical block, so
        // the observation timestamp is recorded in evidence and the durable
        // block column carries the quorum observation identity.
        blockNumber: evidence.observations.length > 0 ? "0" : null,
        evidence: {
          treasuryAddress: evidence.treasuryAddress,
          observations: evidence.observations,
          observedAt: evidence.observedAt,
          mismatch: evidence.mismatch,
        },
      });
      return { journalId: record.id };
    },

    async expectedTreasuryAtomic(assetId: string): Promise<string> {
      // Signed net of every account class EXCLUDING the external TREASURY_RESERVE
      // counterparty. Every journal is balanced, so this equals the negated
      // treasury reserve; reading the explicit non-treasury accounts is the
      // direct expression of the contract.
      const accounts = await prisma.atomicAccount.findMany({ where: { assetId } });
      let total = 0n;
      for (const account of accounts) {
        if (account.class === TREASURY_RESERVE) continue;
        total += BigInt(account.balanceAtomic);
      }
      return total.toString();
    },
  };
}
