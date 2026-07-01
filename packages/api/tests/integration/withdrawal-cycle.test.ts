/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { initTestContext, runCleanup } from "../helpers/test-utils.js";
import type { TestContext } from "../helpers/test-utils.js";

describe("Withdrawal Lifecycle Integration", () => {
  let ctx: TestContext;
  let signer: ReturnType<typeof privateKeyToAccount>;
  let signerAddress: string;
  let blockchainId: string;
  let tokenId: string;
  let userId: string;
  let authToken: string;

  const createMsg = (amount: number, address: string, nonce: string, timestamp: number) => ({
    nonce,
    timestamp,
    message: `Withdraw ${amount} USD to ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`,
  });

  beforeEach(async () => {
    ctx = await initTestContext(1, 10000);

    // Generate a fresh signer per test and update the seeded user's address
    signer = privateKeyToAccount(generatePrivateKey());
    signerAddress = signer.address;

    const user = ctx.users[0];
    userId = user.id;

    await ctx.app.prisma.user.update({
      where: { id: userId },
      data: { address: signerAddress.toLowerCase() },
    });

    // Issue a new JWT + session so the authenticate decorator succeeds
    const jti = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    authToken = ctx.app.jwt.sign(
      { userId, address: signerAddress.toLowerCase(), jti },
      { jti, expiresIn: "1h" }
    );
    await ctx.app.prisma.session.create({
      data: {
        userId,
        jti,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    // Create blockchain
    const blockchain = await ctx.app.prisma.blockchain.upsert({
      where: { chainId: 31338 },
      create: {
        name: "Local Testnet",
        chainId: 31338,
        rpcUrl: "http://localhost:8545",
        explorerUrl: "http://localhost:4000",
        nativeCurrency: JSON.stringify({
          name: "Ether",
          symbol: "ETH",
          decimals: 18,
        }),
        isEnabled: true,
        confirmations: 1,
      },
      update: {
        isEnabled: true,
        confirmations: 1,
        rpcUrl: "http://localhost:8545",
      },
    });
    blockchainId = blockchain.id;

    // Create token (low minDeposit to allow small-amount float test)
    const token = await ctx.app.prisma.token.upsert({
      where: {
        blockchainId_address: {
          blockchainId: blockchain.id,
          address: "0x1234567890123456789012345678901234567890",
        },
      },
      create: {
        blockchainId: blockchain.id,
        address: "0x1234567890123456789012345678901234567890",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        minDeposit: "1",
        isEnabled: true,
      },
      update: {
        minDeposit: "1",
        decimals: 6,
        isEnabled: true,
      },
    });
    tokenId = token.id;
  });

  afterEach(async () => {
    // PaymentTransactions reference userId AND tokenId/blockchainId;
    // clean them first to avoid FK violations later.
    if (userId) {
      await ctx.app.prisma.paymentTransaction.deleteMany({ where: { userId } });
    }
    if (blockchainId) {
      await ctx.app.prisma.token.deleteMany({ where: { blockchainId } });
      await ctx.app.prisma.blockchain.deleteMany({ where: { id: blockchainId } });
    }
    await runCleanup(ctx.cleanup);
  });

  it("completes the full withdrawal lifecycle at the DB level", async () => {
    const destAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 100;
    const nonce = `lifecycle-${Date.now()}`;
    const timestamp = Date.now();
    const { message } = createMsg(amount, destAddress, nonce, timestamp);
    const signature = await signer.signMessage({ message });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: destAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    // ---- HTTP status & body ----
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("pending");
    expect(body.amount).toBe(amount);
    expect(body.destination).toBe(destAddress);
    expect(body.id).toBeDefined();
    expect(body.ledgerEntryId).toBeDefined();

    // ---- MAIN balance decreased ----
    // Initial balance is 10000 cents ($100.00). Withdrawing $100 debits 10000 cents.
    const mainAccount = await ctx.app.prisma.account.findUniqueOrThrow({
      where: { userId_currency_type: { userId, currency: "USDC", type: "MAIN" } },
    });
    expect(mainAccount.balance).toBe(0n);

    // ---- PENDING_WITHDRAWAL balance equals the withdrawn amount ----
    const pendingAccount = await ctx.app.prisma.account.findUniqueOrThrow({
      where: { userId_currency_type: { userId, currency: "USDC", type: "PENDING_WITHDRAWAL" } },
    });
    expect(pendingAccount.balance).toBe(10000n); // $100 = 10000 cents

    // ---- PaymentTransaction in AWAITING_BROADCAST / PENDING ----
    const paymentTx = await ctx.app.prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(paymentTx.type).toBe("WITHDRAWAL");
    expect(paymentTx.status).toBe("PENDING");
    expect(paymentTx.recoveryState).toBe("AWAITING_BROADCAST");
    expect(paymentTx.amountCredit).toBe(10000n);
    expect(paymentTx.ledgerEntryId).toBe(body.ledgerEntryId);

    // ---- TWO ledger entries: debit MAIN + credit PENDING_WITHDRAWAL ----
    const entries = await ctx.app.prisma.ledgerEntry.findMany({
      where: {
        account: { userId },
        type: "WITHDRAWAL",
      },
    });
    expect(entries).toHaveLength(2);

    const debitEntry = entries.find((e) => e.amount < 0n);
    const creditEntry = entries.find((e) => e.amount > 0n);
    expect(debitEntry).toBeDefined();
    expect(creditEntry).toBeDefined();
    expect(debitEntry!.amount).toBe(-10000n);
    expect(creditEntry!.amount).toBe(10000n);
    // Both should reference the same withdrawal
    const debitMeta = debitEntry!.metadata as Record<string, unknown>;
    const creditMeta = creditEntry!.metadata as Record<string, unknown>;
    expect(debitMeta.idempotencyKey).toBe(nonce);
    expect(creditMeta.idempotencyKey).toBe(nonce);
  });

  it("returns idempotent response when replaying the same idempotencyKey", async () => {
    const destAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 50;
    const idempotencyKey = `idem-${Date.now()}`;
    const timestamp = Date.now();
    const { message } = createMsg(amount, destAddress, idempotencyKey, timestamp);
    const signature = await signer.signMessage({ message });

    // First request
    const res1 = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: destAddress,
        message,
        signature,
        idempotencyKey,
      },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();

    // Second request with same idempotencyKey
    const res2 = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: destAddress,
        message,
        signature,
        idempotencyKey,
      },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();

    expect(body2.message).toContain("already submitted");
    expect(body2.id).toBe(body1.id);
    expect(body2.ledgerEntryId).toBe(body1.ledgerEntryId);

    // Balance debited only once (10000 - 50 = 9950 cents)
    const mainAccount = await ctx.app.prisma.account.findUniqueOrThrow({
      where: { userId_currency_type: { userId, currency: "USDC", type: "MAIN" } },
    });
    expect(mainAccount.balance).toBe(5000n); // 10000 - 5000 = 5000 cents
  });

  it("rejects a message whose timestamp is in the future", async () => {
    const destAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 10;
    const nonce = `future-${Date.now()}`;
    const futureTimestamp = Date.now() + 60_000; // 1 minute in the future
    const { message } = createMsg(amount, destAddress, nonce, futureTimestamp);
    const signature = await signer.signMessage({ message });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: destAddress,
        message,
        signature,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("expired");
  });

  it("preserves fractional cents correctly (float-to-integer)", async () => {
    const destAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 0.29;
    const nonce = `float-${Date.now()}`;
    const timestamp = Date.now();
    const { message } = createMsg(amount, destAddress, nonce, timestamp);
    const signature = await signer.signMessage({ message });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: destAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    expect(response.statusCode).toBe(200);

    const ledgerEntries = await ctx.app.prisma.ledgerEntry.findMany({
      where: {
        account: { userId },
        type: "WITHDRAWAL",
      },
    });

    const debitEntry = ledgerEntries.find((e) => e.amount < 0n);
    expect(debitEntry).toBeDefined();
    // 0.29 USD = 29 cents (NOT 28)
    expect(debitEntry!.amount).toBe(-29n);
  });
});
