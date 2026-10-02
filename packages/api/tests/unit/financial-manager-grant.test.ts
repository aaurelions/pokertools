import { expect, it, vi } from "vitest";
import { FinancialManager } from "../../src/services/financial-manager.js";
import { ChipLedger } from "../../src/services/chip-ledger.js";

it("retries a transient grant transaction without changing its idempotency identity", async () => {
  const transaction = {};
  const prisma = {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(transaction)),
  };
  const timeout = Object.assign(new Error("Operation has timed out"), { code: "P1008" });
  const result = { grantId: "one-grant" };
  const grant = vi
    .spyOn(ChipLedger.prototype, "grant")
    .mockRejectedValueOnce(timeout)
    .mockResolvedValueOnce(result as never);
  try {
    const options = {
      reason: "operator grant",
      operatorId: "operator",
      idempotencyKey: "stable-grant",
    };
    expect(await new FinancialManager(prisma as never).grantChips("player", 100, options)).toBe(
      result
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(grant.mock.calls[0]).toEqual(grant.mock.calls[1]);
    expect(grant.mock.calls[1][1].idempotencyKey).toBe("stable-grant");
  } finally {
    grant.mockRestore();
  }
});
