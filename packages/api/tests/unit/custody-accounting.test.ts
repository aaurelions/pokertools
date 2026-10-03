import { describe, expect, it, vi } from "vitest";
import {
  createCustodyAccounting,
  type CustodyAccountingRecord,
} from "../../src/services/custody-accounting.js";
import type { AtomicLedger } from "../../src/services/atomic-ledger.js";
import type { PrismaClient } from "../../generated/prisma/index.js";

const ASSET_ID = "eip155:31337/erc20:0x1111111111111111111111111111111111111111";

const RECORD: CustodyAccountingRecord = {
  intentId: "int_1",
  principalId: "principal_1",
  assetId: ASSET_ID,
  chainId: 31337,
  amountAtomic: "500",
};

const TX_HASH = "0x" + "11".repeat(32);
const PRIOR_RECEIPT = { number: "40", hash: "0x" + "21".repeat(32) };
const REINCLUDED_RECEIPT = { number: "42", hash: "0x" + "22".repeat(32) };
const SECOND_REINCLUDED_RECEIPT = { number: "44", hash: "0x" + "24".repeat(32) };

const OBLIGATION_EVIDENCE = {
  txHash: TX_HASH,
  priorReceiptBlockNumber: PRIOR_RECEIPT.number,
  priorReceiptBlockHash: PRIOR_RECEIPT.hash,
};

const REVERSAL_EVIDENCE = {
  txHash: TX_HASH,
  receiptBlockNumber: REINCLUDED_RECEIPT.number,
  receiptBlockHash: REINCLUDED_RECEIPT.hash,
};

interface FakeJournal {
  id: string;
  requestId: string;
  assetId: string;
  postings: Array<{ accountId: string; amountAtomic: string }>;
}

function makeLedger() {
  const journals = new Map<string, FakeJournal>();
  let seq = 0;
  const ledger = {
    lockAsset: vi.fn(async () => true),
    ensureAccount: vi.fn(async (_tx: unknown, params: { class: string }) => ({
      accountId: params.class,
    })),
    post: vi.fn(async (_tx: unknown, input: FakeJournal) => {
      const existing = journals.get(input.requestId);
      if (existing) return existing;
      seq += 1;
      const journal = { ...input, id: `j_${seq}` };
      journals.set(input.requestId, journal);
      return journal;
    }),
    readJournal: vi.fn(async (_tx: unknown, requestId: string) => journals.get(requestId) ?? null),
  };
  return { ledger, journals };
}

interface FakeControl {
  /** Number of upcoming reorg-pointer CAS updates that must lose. */
  pointerCasFailures: number;
  /** Optional hook run when a simulated CAS loss happens. */
  onPointerCasFailure?: () => void;
  /** Serve this stale row for the next N findUnique reads. */
  staleRow?: Record<string, unknown>;
  staleReads?: number;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (row[key] !== expected) return false;
  }
  return true;
}

function makePrisma(
  intent: Record<string, unknown>,
  journals?: Map<string, FakeJournal>,
  control: FakeControl = { pointerCasFailures: 0 }
) {
  const updateManyCalls: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const tx = {
    withdrawalIntentRecord: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if ((intent.id as string) !== where.id) return null;
        if (control.staleRow && (control.staleReads ?? 0) > 0) {
          control.staleReads = (control.staleReads ?? 0) - 1;
          return control.staleRow;
        }
        return intent;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          updateManyCalls.push({ where, data });
          if (!matchesWhere(intent, where)) return { count: 0 };
          // Simulate a concurrent writer committing a different pointer
          // between our read and our CAS.
          if (control.pointerCasFailures > 0 && "reorgJournalId" in data) {
            control.pointerCasFailures -= 1;
            control.onPointerCasFailure?.();
            return { count: 0 };
          }
          for (const [key, value] of Object.entries(data)) intent[key] = value;
          return { count: 1 };
        }
      ),
    },
    journalTransaction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (!journals) return null;
        for (const journal of journals.values()) {
          if (journal.id === where.id) {
            return { ...journal, assetId: ASSET_ID, postings: journal.postings };
          }
        }
        return null;
      }),
    },
    atomicAccount: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, class: id }))
      ),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      // Transactional rollback semantics: on throw, every write made inside
      // the callback is undone (journals included), exactly like PostgreSQL.
      const intentSnapshot = { ...intent };
      const journalSnapshot = journals
        ? new Map([...journals].map(([key, value]) => [key, structuredClone(value)]))
        : null;
      try {
        return await work(tx);
      } catch (error) {
        for (const key of Object.keys(intent)) delete intent[key];
        Object.assign(intent, intentSnapshot);
        if (journals && journalSnapshot) {
          journals.clear();
          for (const [key, value] of journalSnapshot) journals.set(key, value);
        }
        throw error;
      }
    },
    asset: { findUnique: async () => ({ ledgerVersion: 3 }) },
    atomicAccount: {
      findMany: async () => [
        { class: "USER_AVAILABLE", balanceAtomic: "700" },
        { class: "PENDING_WITHDRAWAL", balanceAtomic: "300" },
        { class: "TREASURY_RESERVE", balanceAtomic: "-1000" },
        { class: "INCIDENT_OBLIGATION", balanceAtomic: "5" },
      ],
    },
  };
  return { prisma, tx, updateManyCalls };
}

function reorgedIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    assetId: ASSET_ID,
    principalId: "principal_1",
    amountAtomic: "500",
    confirmedJournalId: null,
    reorgJournalId: null,
    state: "REORGED",
    txHash: TX_HASH,
    receiptBlockNumber: PRIOR_RECEIPT.number,
    receiptBlockHash: PRIOR_RECEIPT.hash,
    ...overrides,
  };
}

function makeAccounting(intent: Record<string, unknown>, control?: FakeControl) {
  const { ledger, journals } = makeLedger();
  const { prisma, updateManyCalls } = makePrisma(intent, journals, control);
  const accounting = createCustodyAccounting({
    prisma: prisma as unknown as PrismaClient,
    ledger: ledger as unknown as AtomicLedger,
  });
  return { accounting, journals, updateManyCalls };
}

describe("createCustodyAccounting lifecycle ownership", () => {
  it("posts the settlement journal and updates confirmedJournalId only, never state", async () => {
    const intent: Record<string, unknown> = reorgedIntent({
      state: "CONFIRMED",
      receiptBlockHash: null,
      receiptBlockNumber: null,
    });
    const { accounting, journals, updateManyCalls } = makeAccounting(intent);

    const result = await accounting.completeWithdrawal(RECORD);
    expect(result.journalId).toBe("j_1");

    const journal = journals.get("withdrawal-settle:int_1")!;
    expect(journal.postings).toEqual([
      { accountId: "PENDING_WITHDRAWAL", amountAtomic: "-500" },
      { accountId: "TREASURY_RESERVE", amountAtomic: "500" },
    ]);

    // Journal-id columns only: the custody CAS owns CONFIRMED/FINALIZED/REORGED.
    expect(updateManyCalls).toHaveLength(1);
    expect(Object.keys(updateManyCalls[0].data)).toEqual(["confirmedJournalId"]);
    expect(intent.state).toBe("CONFIRMED");

    // Idempotent: a second completion returns the same journal and does not
    // repost or re-touch the row.
    updateManyCalls.length = 0;
    const again = await accounting.completeWithdrawal(RECORD);
    expect(again.journalId).toBe("j_1");
    expect(updateManyCalls).toHaveLength(0);
  });

  it("refuses a reorg obligation before the exact settlement journal exists", async () => {
    const intent = reorgedIntent();
    const { accounting } = makeAccounting(intent);

    await expect(
      accounting.recordObligation(RECORD, { incidentId: "inc_1" }, OBLIGATION_EVIDENCE)
    ).rejects.toThrow(/before settlement completes/);
  });

  it("records the reorg obligation once, after settlement, with journal-id only", async () => {
    const intent = reorgedIntent();
    const { accounting, journals, updateManyCalls } = makeAccounting(intent);

    await accounting.completeWithdrawal(RECORD);
    const obligation = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_1" },
      OBLIGATION_EVIDENCE
    );
    expect(obligation.journalId).toBe("j_2");

    const journal = journals.get("withdrawal-reorg:int_1")!;
    expect(journal.postings).toEqual([
      { accountId: "INCIDENT_OBLIGATION", amountAtomic: "500" },
      { accountId: "TREASURY_RESERVE", amountAtomic: "-500" },
    ]);
    // No update ever names `state`.
    for (const call of updateManyCalls) {
      expect(call.data).not.toHaveProperty("state");
    }
    expect(intent.reorgJournalId).toBe("j_2");
  });

  it("reverses the outstanding obligation once when the exact payout re-finalizes, never re-settling", async () => {
    const intent = reorgedIntent();
    const { accounting, journals, updateManyCalls } = makeAccounting(intent);

    await accounting.completeWithdrawal(RECORD);
    const obligation = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_1" },
      OBLIGATION_EVIDENCE
    );
    expect(obligation.journalId).not.toBeNull();

    // The exact payout re-includes: the durable row now carries the new
    // canonical receipt identity and the confirmation-stage state.
    intent.state = "PENDING_CONFIRMATION";
    intent.receiptBlockNumber = REINCLUDED_RECEIPT.number;
    intent.receiptBlockHash = REINCLUDED_RECEIPT.hash;

    const reversal = await accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE);
    expect(reversal.journalId).not.toBeNull();
    const reversalJournal = journals.get(`withdrawal-reorg-reverse:${obligation.journalId}`)!;
    expect(reversalJournal.postings).toEqual([
      { accountId: "INCIDENT_OBLIGATION", amountAtomic: "-500" },
      { accountId: "TREASURY_RESERVE", amountAtomic: "500" },
    ]);
    // Settlement is never replayed and no refund journal is ever posted.
    expect([...journals.keys()].filter((key) => key.startsWith("withdrawal-settle:"))).toHaveLength(
      1
    );
    for (const journal of journals.values()) {
      expect(journal.postings.some((posting) => posting.accountId === "USER_AVAILABLE")).toBe(
        false
      );
    }

    // Idempotent: retrying the same reversal returns the same journal.
    const again = await accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE);
    expect(again.journalId).toBe(reversal.journalId);
    expect(journals.size).toBe(3);

    // The durable pointer is retained for the next cycle, which chains a fresh
    // obligation off the reversal journal id instead of replaying the reversed
    // one.
    expect(intent.reorgJournalId).toBe(obligation.journalId);
    intent.state = "REORGED";
    intent.receiptBlockNumber = REINCLUDED_RECEIPT.number;
    intent.receiptBlockHash = REINCLUDED_RECEIPT.hash;
    const second = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_2" },
      {
        txHash: TX_HASH,
        priorReceiptBlockNumber: REINCLUDED_RECEIPT.number,
        priorReceiptBlockHash: REINCLUDED_RECEIPT.hash,
      }
    );
    expect(second.journalId).not.toBe(obligation.journalId);
    expect(journals.has(`withdrawal-reorg:int_1:after:${reversal.journalId}`)).toBe(true);

    intent.state = "PENDING_CONFIRMATION";
    intent.receiptBlockNumber = SECOND_REINCLUDED_RECEIPT.number;
    intent.receiptBlockHash = SECOND_REINCLUDED_RECEIPT.hash;
    const secondReversal = await accounting.reverseObligation(RECORD, {
      txHash: TX_HASH,
      receiptBlockNumber: SECOND_REINCLUDED_RECEIPT.number,
      receiptBlockHash: SECOND_REINCLUDED_RECEIPT.hash,
    });
    expect(journals.get(`withdrawal-reorg-reverse:${second.journalId}`)).toBeDefined();
    expect(secondReversal.journalId).not.toBe(reversal.journalId);
    expect([...journals.keys()].filter((key) => key.startsWith("withdrawal-settle:"))).toHaveLength(
      1
    );

    // Journal-id columns only: the custody CAS owns CONFIRMED/FINALIZED/REORGED.
    for (const call of updateManyCalls) {
      expect(call.data).not.toHaveProperty("state");
    }
  });

  it("posts no obligation when the caller's reorg evidence is superseded by durable state", async () => {
    const intent = reorgedIntent();
    const { accounting, journals } = makeAccounting(intent);
    await accounting.completeWithdrawal(RECORD);

    // Re-inclusion won: state advanced and the receipt moved.
    intent.state = "PENDING_CONFIRMATION";
    intent.receiptBlockNumber = REINCLUDED_RECEIPT.number;
    intent.receiptBlockHash = REINCLUDED_RECEIPT.hash;
    const stale = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_1" },
      OBLIGATION_EVIDENCE
    );
    expect(stale).toEqual({ journalId: null });
    expect(journals.has("withdrawal-reorg:int_1")).toBe(false);

    // Same state but a different durable prior receipt also refuses.
    intent.state = "REORGED";
    intent.receiptBlockNumber = "99";
    intent.receiptBlockHash = "0x" + "99".repeat(32);
    expect(
      await accounting.recordObligation(RECORD, { incidentId: "inc_1" }, OBLIGATION_EVIDENCE)
    ).toEqual({ journalId: null });
    expect(journals.has("withdrawal-reorg:int_1")).toBe(false);
  });

  it("posts no reversal when the record reorged away again or the receipt moved", async () => {
    const intent = reorgedIntent();
    const { accounting, journals } = makeAccounting(intent);
    await accounting.completeWithdrawal(RECORD);
    const obligation = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_1" },
      OBLIGATION_EVIDENCE
    );

    // Re-included, then reorged away again before finality: state REORGED with
    // the re-included receipt still recorded. Never reverse here.
    intent.state = "REORGED";
    intent.receiptBlockNumber = REINCLUDED_RECEIPT.number;
    intent.receiptBlockHash = REINCLUDED_RECEIPT.hash;
    expect(await accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE)).toEqual({
      journalId: null,
    });
    expect(journals.has(`withdrawal-reorg-reverse:${obligation.journalId}`)).toBe(false);

    // Confirmation-stage but a different receipt than the caller observed.
    intent.state = "PENDING_CONFIRMATION";
    intent.receiptBlockNumber = "77";
    intent.receiptBlockHash = "0x" + "77".repeat(32);
    expect(await accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE)).toEqual({
      journalId: null,
    });
    expect(journals.has(`withdrawal-reorg-reverse:${obligation.journalId}`)).toBe(false);
  });

  it("refuses a reversal before settlement or with mismatched payout evidence", async () => {
    const unsettled = reorgedIntent({
      confirmedJournalId: null,
      reorgJournalId: "j_obligation",
      state: "PENDING_CONFIRMATION",
      receiptBlockNumber: REINCLUDED_RECEIPT.number,
      receiptBlockHash: REINCLUDED_RECEIPT.hash,
    });
    {
      const { accounting } = makeAccounting(unsettled);
      await expect(accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE)).rejects.toThrow(
        /before settlement completes/
      );
    }

    const settled = reorgedIntent({
      reorgJournalId: "j_obligation",
      state: "PENDING_CONFIRMATION",
      receiptBlockNumber: REINCLUDED_RECEIPT.number,
      receiptBlockHash: REINCLUDED_RECEIPT.hash,
    });
    const { accounting, journals } = makeAccounting(settled);
    await accounting.completeWithdrawal(RECORD);
    await expect(
      accounting.reverseObligation(RECORD, {
        ...REVERSAL_EVIDENCE,
        txHash: "0x" + "33".repeat(32),
      })
    ).rejects.toThrow(/does not match the persisted payout/);
    await expect(
      accounting.reverseObligation(RECORD, { ...REVERSAL_EVIDENCE, receiptBlockHash: "" })
    ).rejects.toThrow(/receipt block identity/);
    expect(
      [...journals.keys()].filter((key) => key.startsWith("withdrawal-reorg-reverse:"))
    ).toHaveLength(0);
  });

  it("returns null when there is no outstanding obligation to reverse", async () => {
    const intent = reorgedIntent({
      state: "CONFIRMED",
      receiptBlockNumber: REINCLUDED_RECEIPT.number,
      receiptBlockHash: REINCLUDED_RECEIPT.hash,
    });
    const { accounting } = makeAccounting(intent);
    await accounting.completeWithdrawal(RECORD);
    expect(await accounting.reverseObligation(RECORD, REVERSAL_EVIDENCE)).toEqual({
      journalId: null,
    });
  });

  it("rolls back a posted obligation when the durable pointer CAS keeps losing", async () => {
    const intent = reorgedIntent();
    const { accounting, journals } = makeAccounting(intent, {
      pointerCasFailures: Number.MAX_SAFE_INTEGER,
    });
    await accounting.completeWithdrawal(RECORD);
    const journalCountAfterSettle = journals.size;

    await expect(
      accounting.recordObligation(RECORD, { incidentId: "inc_1" }, OBLIGATION_EVIDENCE)
    ).rejects.toThrow(/Reorg cycle pointer conflicted/);

    // The loser's journal rolled back with its transaction and the pointer was
    // never advanced: no unpointed liability.
    expect(journals.size).toBe(journalCountAfterSettle);
    expect(journals.has("withdrawal-reorg:int_1")).toBe(false);
    expect(intent.reorgJournalId).toBeNull();
  });

  it("retries a lost pointer CAS against fresh durable state and converges on the winner", async () => {
    const intent = reorgedIntent();
    const control: FakeControl = {
      pointerCasFailures: 0,
      staleRow: { ...intent },
      staleReads: 1,
    };
    const { accounting, journals } = makeAccounting(intent, control);
    await accounting.completeWithdrawal(RECORD);
    const settleJournalId = journals.get("withdrawal-settle:int_1")!.id;

    // A concurrent winner committed the first-cycle obligation between the
    // loser's read and its CAS.
    intent.reorgJournalId = "j_winner";
    journals.set("withdrawal-reorg:int_1", {
      id: "j_winner",
      requestId: "withdrawal-reorg:int_1",
      assetId: ASSET_ID,
      postings: [
        { accountId: "INCIDENT_OBLIGATION", amountAtomic: "500" },
        { accountId: "TREASURY_RESERVE", amountAtomic: "-500" },
      ],
    });

    const result = await accounting.recordObligation(
      RECORD,
      { incidentId: "inc_1" },
      OBLIGATION_EVIDENCE
    );
    expect(result).toEqual({ journalId: "j_winner" });
    expect(intent.reorgJournalId).toBe("j_winner");
    // Exactly one obligation journal exists; the retry did not fork the cycle.
    expect(
      [...journals.keys()].filter(
        (key) =>
          key.startsWith("withdrawal-reorg:") &&
          !key.includes(":after:") &&
          !key.includes("reverse")
      )
    ).toEqual(["withdrawal-reorg:int_1"]);
    expect(journals.get("withdrawal-settle:int_1")!.id).toBe(settleJournalId);
  });
});

describe("createCustodyAccounting expected balance", () => {
  it("sums the signed net of all non-TREASURY_RESERVE classes", async () => {
    const { prisma } = makePrisma({});
    const { ledger } = makeLedger();
    const accounting = createCustodyAccounting({
      prisma: prisma as unknown as PrismaClient,
      ledger: ledger as unknown as AtomicLedger,
    });

    // 700 + 300 + 5, excluding TREASURY_RESERVE (-1000).
    expect(await accounting.expectedTreasuryAtomic(ASSET_ID)).toBe("1005");
  });
});
