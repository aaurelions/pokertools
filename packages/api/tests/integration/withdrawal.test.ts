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

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    prisma = app.prisma;

    // Clean up any existing test data
    // Fix: Ensure we delete by lowercase address (as stored in DB) to prevent unique constraint errors
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
    // 1. Delete Tokens (depend on Blockchain)
    await prisma.token.deleteMany({ where: { blockchainId } });

    // 2. Delete User (cascades to Accounts -> LedgerEntries)
    // Fix: Use lowercase address for cleanup
    await prisma.user.deleteMany({ where: { address: testAddress.toLowerCase() } });

    // 3. Delete Blockchain (now safe as Tokens are gone)
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
    const message = `Withdraw ${amount} USD to ${withdrawalAddress}`;

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
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("pending");
    expect(body.amount).toBe(amount);
    expect(body.destination).toBe(withdrawalAddress);
    expect(body.id).toBeDefined();

    // Verify ledger entry was created
    const ledgerEntry = await prisma.ledgerEntry.findUnique({
      where: { id: body.id },
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
    expect(queuedId).toBe(body.id);
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
    const message = `Withdraw ${amount} USD to ${withdrawalAddress}`;
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
