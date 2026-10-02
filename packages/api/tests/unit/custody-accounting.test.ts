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

function makePrisma(intent: Record<string, unknown>) {
  const updateManyCalls: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const tx = {
    withdrawalIntentRecord: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (intent.id as string) === where.id ? intent : null
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          updateManyCalls.push({ where, data });
          // Apply only the named journal-id columns to the in-memory row, as a
          // real update would; `state` is never among them.
          for (const [key, value] of Object.entries(data)) intent[key] = value;
          return { count: 1 };
        }
      ),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
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

describe("createCustodyAccounting lifecycle ownership", () => {
  it("posts the settlement journal and updates confirmedJournalId only, never state", async () => {
    const intent: Record<string, unknown> = {
      id: "int_1",
      assetId: ASSET_ID,
      principalId: "principal_1",
      amountAtomic: "500",
      confirmedJournalId: null,
      reorgJournalId: null,
      state: "CONFIRMED",
    };
    const { prisma, updateManyCalls } = makePrisma(intent);
    const { ledger, journals } = makeLedger();

    const accounting = createCustodyAccounting({
      prisma: prisma as unknown as PrismaClient,
      ledger: ledger as unknown as AtomicLedger,
    });

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

  it("refuses a reorg obligation before the settlement journal exists", async () => {
    const intent: Record<string, unknown> = {
      id: "int_1",
      assetId: ASSET_ID,
      principalId: "principal_1",
      amountAtomic: "500",
      confirmedJournalId: null,
      reorgJournalId: null,
      state: "CONFIRMED",
    };
    const { prisma } = makePrisma(intent);
    const { ledger } = makeLedger();

    const accounting = createCustodyAccounting({
      prisma: prisma as unknown as PrismaClient,
      ledger: ledger as unknown as AtomicLedger,
    });

    await expect(accounting.recordObligation(RECORD, { incidentId: "inc_1" })).rejects.toThrow(
      /before settlement completes/
    );
  });

  it("records the reorg obligation once, after settlement, with journal-id only", async () => {
    const intent: Record<string, unknown> = {
      id: "int_1",
      assetId: ASSET_ID,
      principalId: "principal_1",
      amountAtomic: "500",
      confirmedJournalId: null,
      reorgJournalId: null,
      state: "CONFIRMED",
    };
    const { prisma, updateManyCalls } = makePrisma(intent);
    const { ledger, journals } = makeLedger();

    const accounting = createCustodyAccounting({
      prisma: prisma as unknown as PrismaClient,
      ledger: ledger as unknown as AtomicLedger,
    });

    await accounting.completeWithdrawal(RECORD);
    const obligation = await accounting.recordObligation(RECORD, { incidentId: "inc_1" });
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
