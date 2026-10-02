import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_UINT256 } from "@pokertools/types";
import {
  computeJournalPayloadHash,
  isTransientTransactionConflict,
  isUniqueViolation,
  LedgerInvariantError,
  parseSignedAtomic,
  serializeSignedAtomic,
} from "../../src/services/atomic-ledger.js";

describe("atomic journal primitives", () => {
  it("round-trips arbitrary-precision signed amounts without numeric conversion", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -MAX_UINT256, max: MAX_UINT256 }), (amountAtomic) => {
        expect(parseSignedAtomic(serializeSignedAtomic(amountAtomic))).toBe(amountAtomic);
      })
    );
  });
  it.each([null, undefined, 1, 1n, "", "-0", "00", "01", "+1", " 1", "1 ", "1.0", "1e3"])(
    "rejects noncanonical atomic input %s",
    (value) => {
      expect(() => parseSignedAtomic(value)).toThrow(LedgerInvariantError);
    }
  );
  it.each([MAX_UINT256 + 1n, -MAX_UINT256 - 1n])(
    "rejects out-of-range atomic amounts",
    (amountAtomic) => {
      expect(() => parseSignedAtomic(amountAtomic.toString())).toThrow(LedgerInvariantError);
      expect(() => serializeSignedAtomic(amountAtomic)).toThrow(LedgerInvariantError);
    }
  );
  it("hashes posting permutations identically while preserving duplicate legs and asset identity", () => {
    const postings = [
      { accountId: "reserve", amountAtomic: "-10" },
      { accountId: "user", amountAtomic: "5" },
      { accountId: "user", amountAtomic: "5" },
      { accountId: "user", amountAtomic: "0" },
    ];
    const hash = computeJournalPayloadHash("asset-a", postings);
    expect(computeJournalPayloadHash("asset-a", [...postings].reverse())).toBe(hash);
    expect(computeJournalPayloadHash("asset-b", postings)).not.toBe(hash);
    expect(computeJournalPayloadHash("asset-a", postings.slice(0, -1))).not.toBe(hash);
    expect(computeJournalPayloadHash("asset-a", postings.slice(0, -2))).not.toBe(hash);
  });
  it.each(["40001", "40P01", "P2034", "P2028", "P2024"])(
    "recognizes retryable transaction code %s",
    (code) => {
      expect(isTransientTransactionConflict({ code })).toBe(true);
    }
  );
  it("separates unique conflicts from transient transport errors", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isTransientTransactionConflict({ code: "P2002" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error("unrelated"))).toBe(false);
    expect(isTransientTransactionConflict(null)).toBe(false);
    expect(isTransientTransactionConflict(new Error("unrelated"))).toBe(false);
    expect(isTransientTransactionConflict(new Error("Operation has timed out"))).toBe(true);
    expect(isTransientTransactionConflict(new Error("Transaction already closed"))).toBe(true);
  });
});
