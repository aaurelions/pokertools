/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "../../generated/prisma/index.js";
import { privateKeyToAccount } from "viem/accounts";

describe("Withdrawal Endpoint", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let authToken: string;
  let userId: string;
  let blockchainId: string;
  let tokenId: string;

  // Test wallet
  const testPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const testAccount = privateKeyToAccount(testPrivateKey);
  const testAddress = testAccount.address;

  const createWithdrawalMessage = (
    amount: number,
    address: string,
    nonce = `nonce-${Date.now()}`
  ) => {
    const timestamp = Date.now();
    return {
      nonce,
      timestamp,
      message: `Withdraw ${amount} USD to ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`,
    };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    prisma = app.prisma;

    // Clean up any existing test data
    // Fix: Ensure we delete by lowercase address (as stored in DB) to prevent unique constraint errors
    // Delete PaymentTransactions first (child table)
    const existingUser = await prisma.user.findUnique({
      where: { address: testAddress.toLowerCase() },
      include: { accounts: { include: { entries: { include: { paymentTx: true } } } } },
    });
    if (existingUser) {
      await prisma.paymentTransaction.deleteMany({ where: { userId: existingUser.id } });
      await prisma.ledgerEntry.deleteMany({ where: { account: { userId: existingUser.id } } });
      await prisma.userWallet.deleteMany({ where: { userId: existingUser.id } });
      await prisma.depositSession.deleteMany({ where: { userId: existingUser.id } });
      await prisma.session.deleteMany({ where: { userId: existingUser.id } });
      await prisma.account.deleteMany({ where: { userId: existingUser.id } });
    }
    await prisma.user.deleteMany({ where: { address: testAddress.toLowerCase() } });
    // Also clean up by username to be safe
    await prisma.user.deleteMany({ where: { username: "testuser" } });

    // Pre-emptive cleanup to avoid unique constraint collisions on restart
    // We must delete dependents (Transactions, Tokens) before deleting the Blockchain
    const existingChain = await prisma.blockchain.findUnique({
      where: { chainId: 31337 },
    });

    if (existingChain) {
      // 1. Delete PaymentTransactions linked to this chain
      await prisma.paymentTransaction.deleteMany({
        where: { blockchainId: existingChain.id },
      });

      // 2. Delete Tokens linked to this chain
      await prisma.token.deleteMany({
        where: { blockchainId: existingChain.id },
      });

      // 3. Now safe to delete the Blockchain
      await prisma.blockchain.delete({
        where: { id: existingChain.id },
      });
    }

    // Create test blockchain
    const blockchain = await prisma.blockchain.create({
      data: {
        name: "Local Testnet",
        chainId: 31337,
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
    });
    blockchainId = blockchain.id;

    // Create test token
    const token = await prisma.token.create({
      data: {
        blockchainId: blockchain.id,
        address: "0x1234567890123456789012345678901234567890",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        minDeposit: "1000000", // 1 USDC
        isEnabled: true,
      },
    });
    tokenId = token.id;

    // Create test user
    const user = await prisma.user.create({
      data: {
        username: "testuser",
        address: testAddress.toLowerCase(),
        role: "PLAYER",
      },
    });
    userId = user.id;

    // Create MAIN account with balance
    await prisma.account.create({
      data: {
        userId: user.id,
        currency: "USDC",
        type: "MAIN",
        balance: 100000, // $1000.00
      },
    });

    // Create JWT session
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        jti: "test-jti-withdraw",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    authToken = app.jwt.sign({ userId: user.id, jti: session.jti });
  });

  afterAll(async () => {
    // Fix foreign key constraint violation by deleting dependents first
    // 1. Delete PaymentTransactions (depend on Token and Blockchain, User)
    await prisma.paymentTransaction.deleteMany({ where: { userId } });

    // 2. Delete LedgerEntries
    await prisma.ledgerEntry.deleteMany({ where: { account: { userId } } });

    // 3. Delete Tokens (depend on Blockchain)
    await prisma.token.deleteMany({ where: { blockchainId } });

    // 4. Delete User (cascades to Accounts -> LedgerEntries)
    await prisma.account.deleteMany({ where: { userId } });
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    // 5. Delete Blockchain (now safe as Tokens are gone)
    await prisma.blockchain.deleteMany({ where: { id: blockchainId } });

    await app.close();
  });

  it("should reject withdrawal without signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        amount: 100,
        blockchainId,
        tokenId,
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        message: "Withdraw 100 USD to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        // Missing signature
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject withdrawal with invalid signature", async () => {
    const invalidSignature = "0x" + "0".repeat(130); // Invalid signature

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        amount: 100,
        blockchainId,
        tokenId,
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        message: "Withdraw 100 USD to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        signature: invalidSignature,
      },
    });

    expect(response.statusCode).toBe(400);
    // Error comes from Zod validation or verifyMessage
    expect(response.json().error).toBeDefined();
  });

  it("should successfully create withdrawal request with valid signature", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 100; // $100 USD
    const { message, nonce } = createWithdrawalMessage(amount, withdrawalAddress);

    // Sign the message with the test account
    const signature = await testAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("pending");
    expect(body.amount).toBe(amount);
    expect(body.destination).toBe(withdrawalAddress);
    expect(body.id).toBeDefined();

    // Verify PaymentTransaction was created (in the same DB transaction)
    const paymentTx = await prisma.paymentTransaction.findUnique({
      where: { id: body.id },
    });
    expect(paymentTx).toBeDefined();
    expect(paymentTx!.type).toBe("WITHDRAWAL");
    expect(paymentTx!.status).toBe("PENDING");
    expect(paymentTx!.amountCredit).toBe(10000); // $100 in cents

    // Verify ledger entry was created and linked
    expect(body.ledgerEntryId).toBeDefined();
    const ledgerEntry = await prisma.ledgerEntry.findUnique({
      where: { id: body.ledgerEntryId },
    });
    expect(ledgerEntry).toBeDefined();
    expect(ledgerEntry!.type).toBe("WITHDRAWAL");
    expect(ledgerEntry!.amount).toBe(-10000); // -$100 in cents

    // Verify metadata contains proof
    const metadata = ledgerEntry!.metadata as any;
    expect(metadata.proof.signer).toBe(testAddress.toLowerCase());
    expect(metadata.proof.signature).toBe(signature);

    // Verify balance was debited
    const account = await prisma.account.findUnique({
      where: {
        userId_currency_type: {
          userId,
          currency: "USDC",
          type: "MAIN",
        },
      },
    });
    expect(account!.balance).toBe(90000); // $1000 - $100 = $900

    // Verify withdrawal was queued in Redis
    const queuedId = await app.redis.rpop("withdrawal_queue");
    expect(queuedId).toBe(body.ledgerEntryId);
  });

  it("should support idempotency key for duplicate withdrawal prevention", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 50;
    const idempotencyKey = `test-idem-${Date.now()}`;
    const { message } = createWithdrawalMessage(amount, withdrawalAddress, idempotencyKey);
    const signature = await testAccount.signMessage({ message });

    // First request
    const response1 = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey,
      },
    });

    expect(response1.statusCode).toBe(200);

    // Second request with same idempotencyKey - should return idempotent response
    const response2 = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey,
      },
    });

    expect(response2.statusCode).toBe(200);
    const body2 = response2.json();
    expect(body2.message).toContain("already submitted");

    // Verify balance was debited only once
    const account = await prisma.account.findUnique({
      where: { userId_currency_type: { userId, currency: "USDC", type: "MAIN" } },
    });
    // After first withdrawal ($100) then second idempotent ($50), total should be $850
    // But idempotent means the second didn't debit, so balance should be $850 ($900 - $50)
    // Actually first withdrawal was $100, starting at $1000. Balance was $900 after first.
    // This second withdrawal for $50 with idempotent key should debit to $850.
    // Second request should be idempotent, so balance stays at $850.
    expect(account!.balance).toBe(85000); // $1000 - $100 - $50 = $850
  });

  it("should accept withdrawal with nonce and timestamp in signed message", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 25;
    const nonce = `nonce-${Date.now()}`;
    const timestamp = Date.now();
    const message = `Withdraw ${amount} USD to ${withdrawalAddress}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
    const signature = await testAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("pending");

    // Verify ledger entry
    const ledgerEntry = await prisma.ledgerEntry.findUnique({
      where: { id: body.ledgerEntryId },
    });
    expect(ledgerEntry).toBeDefined();
    const metadata = ledgerEntry!.metadata as any;
    expect(metadata.idempotencyKey).toBe(nonce);
  });

  it("should reject withdrawal with expired timestamp in message", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 10;
    const nonce = `expired-${Date.now()}`;
    // Timestamp from 10 minutes ago
    const timestamp = Date.now() - 10 * 60 * 1000;
    const message = `Withdraw ${amount} USD to ${withdrawalAddress}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
    const signature = await testAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("expired");
  });

  it("should reject withdrawal below minimum deposit amount", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 0.001; // Way below minDeposit of 1 USDC
    const { message, nonce } = createWithdrawalMessage(amount, withdrawalAddress);
    const signature = await testAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("below minimum");
  });

  it("should reject withdrawal with mismatched message", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 50;
    const wrongMessage = "Some other message";
    const signature = await testAccount.signMessage({ message: wrongMessage });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message: wrongMessage,
        signature,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("does not match withdrawal details");
  });

  it("should reject withdrawal with insufficient balance", async () => {
    const withdrawalAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amount = 10000; // $10,000 - more than available
    const { message, nonce } = createWithdrawalMessage(amount, withdrawalAddress);
    const signature = await testAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/user/withdraw",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      payload: {
        amount,
        blockchainId,
        tokenId,
        address: withdrawalAddress,
        message,
        signature,
        idempotencyKey: nonce,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Insufficient balance");
  });

  it("should get withdrawal history", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/withdrawals",
      headers: {
        authorization: `Bearer ${authToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.withdrawals).toBeDefined();
    expect(Array.isArray(body.withdrawals)).toBe(true);
  });
});
