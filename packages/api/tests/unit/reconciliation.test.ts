import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";

// The reconciliation module creates a BullMQ worker and an ioredis connection at
// import time; stub them so this unit test exercises only the invariant logic.
vi.mock("bullmq", () => ({
  Worker: class {
    on() {
      return this;
    }
    constructor() {}
  },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    constructor() {}
  },
}));

import {
  RECONCILIATION_CODES,
  runReconciliationOnce,
  type ReconciliationLogger,
} from "../../src/workers/reconciliation.js";
import { AtomicLedger, LedgerInvariantError } from "../../src/services/atomic-ledger.js";

interface FakeClientOptions {
  idempotencyDeleted?: number;
  sessionsDeleted?: number;
  chipAccounts?: Array<{ id: string; principalId: string; kind: string; balance: bigint }>;
  chipJournalSum?: bigint;
  assets?: Array<{ id: string }>;
}

function makeClient(options: FakeClientOptions = {}) {
  return {
    idempotencyRecord: {
      deleteMany: vi.fn(async () => ({ count: options.idempotencyDeleted ?? 0 })),
    },
    session: {
      deleteMany: vi.fn(async () => ({ count: options.sessionsDeleted ?? 0 })),
    },
    chipAccount: {
      findMany: vi.fn(async () => options.chipAccounts ?? []),
    },
    chipLedgerEntry: {
      aggregate: vi.fn(async () => ({ _sum: { amount: options.chipJournalSum ?? 0n } })),
    },
    asset: {
      findMany: vi.fn(async () => options.assets ?? []),
    },
  } as unknown as PrismaClient;
}

function makeLogger(): ReconciliationLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconciliation invariants", () => {
  it("reports cleanup counts and healthy invariants without mutating state", async () => {
    const account = { id: "chip_1", principalId: "principal_1", kind: "AVAILABLE", balance: 5n };
    const client = makeClient({
      idempotencyDeleted: 2,
      sessionsDeleted: 3,
      chipAccounts: [account],
      chipJournalSum: 5n,
      assets: [{ id: "asset_1" }],
    });
    const assertAssetBalanced = vi
      .spyOn(AtomicLedger.prototype, "assertAssetBalanced")
      .mockResolvedValue({ postings: 2, transactions: 1, total: "0" });
    const logger = makeLogger();

    const result = await runReconciliationOnce(client, logger, 10);

    expect(result).toMatchObject({
      idempotencyRecordsDeleted: 2,
      sessionsDeleted: 3,
      chipAccountsChecked: 1,
      chipMismatches: 0,
      chipErrors: 0,
      assetsChecked: 1,
      assetMismatches: 0,
      assetErrors: 0,
    });
    expect(assertAssetBalanced).toHaveBeenCalledWith(client, "asset_1");
    // No silent repair: no chip account mutation is attempted.
    expect((client.chipAccount as unknown as { update?: unknown }).update).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a stable code for a chip journal/projection mismatch", async () => {
    const client = makeClient({
      chipAccounts: [{ id: "chip_1", principalId: "principal_1", kind: "AVAILABLE", balance: 5n }],
      chipJournalSum: 7n,
    });
    vi.spyOn(AtomicLedger.prototype, "assertAssetBalanced").mockResolvedValue({
      postings: 0,
      transactions: 0,
      total: "0",
    });
    const logger = makeLogger();

    const result = await runReconciliationOnce(client, logger, 10);

    expect(result.chipMismatches).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: RECONCILIATION_CODES.CHIP_BALANCE_MISMATCH,
        accountId: "chip_1",
        projectedBalance: "5",
        journalSum: "7",
      }),
      expect.any(String)
    );
  });

  it("catches per-asset ledger errors and classifies imbalances vs read failures", async () => {
    const client = makeClient({ assets: [{ id: "asset_1" }, { id: "asset_2" }] });
    vi.spyOn(AtomicLedger.prototype, "assertAssetBalanced")
      .mockRejectedValueOnce(new LedgerInvariantError("Journal transaction is not balanced"))
      .mockRejectedValueOnce(new Error("transient read failure"));
    const logger = makeLogger();

    const result = await runReconciliationOnce(client, logger, 10);

    expect(result.assetsChecked).toBe(2);
    expect(result.assetMismatches).toBe(1);
    expect(result.assetErrors).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: RECONCILIATION_CODES.ATOMIC_LEDGER_UNBALANCED }),
      expect.any(String)
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: RECONCILIATION_CODES.ATOMIC_CHECK_ERROR }),
      expect.any(String)
    );
    // Cleanup failures are reported with their own stable codes, never thrown.
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: RECONCILIATION_CODES.IDEMPOTENCY_CLEANUP_FAILED }),
      expect.any(String)
    );
  });

  it("reports cleanup failures with stable codes instead of throwing", async () => {
    const client = makeClient();
    (client.idempotencyRecord.deleteMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down")
    );
    const logger = makeLogger();

    const result = await runReconciliationOnce(client, logger, 10);

    expect(result.idempotencyRecordsDeleted).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: RECONCILIATION_CODES.IDEMPOTENCY_CLEANUP_FAILED }),
      expect.any(String)
    );
  });
});
