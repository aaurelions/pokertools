/// <reference path="../../types/fastify.d.ts" />
import { afterAll, beforeAll, expect, it } from "vitest";
import { initTestContext, runCleanup, type TestContext } from "../helpers/test-utils.js";
import { refundBroadcastWithdrawal } from "../../../admin/src/services/refund-broadcast-withdrawal.js";

let ctx: TestContext;
let blockchainId: string;
let tokenId: string;
beforeAll(async () => {
  ctx = await initTestContext(1, 1000);
  const chain = await ctx.app.prisma.blockchain.create({
    data: {
      name: "Refund regression",
      chainId: 987654321,
      rpcUrl: "http://127.0.0.1:1",
      explorerUrl: "http://127.0.0.1:1",
      nativeCurrency: JSON.stringify({ name: "Test", symbol: "TEST", decimals: 18 }),
    },
  });
  blockchainId = chain.id;
  const token = await ctx.app.prisma.token.create({
    data: {
      blockchainId,
      address: "0x1234567890123456789012345678901234567890",
      symbol: "USDC",
      name: "Test USDC",
      decimals: 6,
      minDeposit: "1",
    },
  });
  tokenId = token.id;
});
afterAll(async () => {
  if (!ctx) return;
  if (blockchainId) {
    await ctx.app.prisma.paymentTransaction.deleteMany({ where: { blockchainId } });
    await ctx.app.prisma.token.deleteMany({ where: { blockchainId } });
    await ctx.app.prisma.blockchain.delete({ where: { id: blockchainId } });
  }
  await runCleanup(ctx.cleanup);
});

it("refunds once from the broadcast reserve without consuming another pending withdrawal", async () => {
  const db = ctx.app.prisma;
  const userId = ctx.users[0].id;
  const main = await db.account.findUniqueOrThrow({
    where: { userId_currency_type: { userId, currency: "USDC", type: "MAIN" } },
  });
  const pending = await db.account.create({
    data: { userId, currency: "USDC", type: "PENDING_WITHDRAWAL", balance: 500n },
  });
  const reserve = await db.account.create({
    data: { userId, currency: "USDC", type: "HOUSE_RESERVE", balance: 100n },
  });
  const request = await db.ledgerEntry.create({
    data: { accountId: main.id, type: "WITHDRAWAL", amount: -100n },
  });
  await db.ledgerEntry.createMany({
    data: [
      {
        accountId: pending.id,
        type: "WITHDRAWAL",
        amount: -100n,
        referenceId: request.id,
        metadata: { stage: "broadcast-complete" },
      },
      {
        accountId: reserve.id,
        type: "WITHDRAWAL",
        amount: 100n,
        referenceId: request.id,
        metadata: { stage: "broadcast-complete" },
      },
    ],
  });
  const payment = await db.paymentTransaction.create({
    data: {
      userId,
      blockchainId,
      tokenId,
      type: "WITHDRAWAL",
      status: "PROCESSING",
      txHash: "0xrefund-regression",
      address: "0xdestination",
      amountRaw: "1000000",
      amountCredit: 100n,
      ledgerEntryId: request.id,
    },
  });

  expect(await refundBroadcastWithdrawal(db, payment.id, "USDC", "Reverted")).toBe(true);
  expect(await refundBroadcastWithdrawal(db, payment.id, "USDC", "Duplicate monitor")).toBe(false);
  expect((await db.account.findUniqueOrThrow({ where: { id: main.id } })).balance).toBe(
    main.balance + 100n
  );
  expect((await db.account.findUniqueOrThrow({ where: { id: pending.id } })).balance).toBe(500n);
  expect((await db.account.findUniqueOrThrow({ where: { id: reserve.id } })).balance).toBe(0n);
  const refunds = await db.ledgerEntry.findMany({
    where: { referenceId: payment.id, type: "REFUND" },
  });
  expect(refunds).toHaveLength(2);
  expect(refunds.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);
  expect(
    (await db.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } })).status
  ).toBe("FAILED");
});

it("rolls back the refund claim when broadcast accounting cannot support the refund", async () => {
  const db = ctx.app.prisma;
  const userId = ctx.users[0].id;
  const main = await db.account.findUniqueOrThrow({
    where: { userId_currency_type: { userId, currency: "USDC", type: "MAIN" } },
  });
  const request = await db.ledgerEntry.create({
    data: { accountId: main.id, type: "WITHDRAWAL", amount: -100n },
  });
  const payment = await db.paymentTransaction.create({
    data: {
      userId,
      blockchainId,
      tokenId,
      type: "WITHDRAWAL",
      status: "PROCESSING",
      txHash: "0xmissing-broadcast-ledger",
      address: "0xdestination",
      amountRaw: "1000000",
      amountCredit: 100n,
      ledgerEntryId: request.id,
    },
  });
  await expect(refundBroadcastWithdrawal(db, payment.id, "USDC", "Reverted")).rejects.toThrow(
    /reserve entries/
  );
  expect(
    (await db.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } })).status
  ).toBe("PROCESSING");
  expect((await db.account.findUniqueOrThrow({ where: { id: main.id } })).balance).toBe(
    main.balance
  );
});
