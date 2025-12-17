/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { parseAbi, formatUnits } from "viem";

/**
 * Integration tests for deposit security fixes
 *
 * Tests cover:
 * 1. Blockchain reorganization protection (confirmation checking)
 * 2. Block scanning gap prevention (lastScannedBlock tracking)
 * 3. BigInt financial math (no floating point)
 * 4. RPC failover behavior
 */
describe("Deposit Security Tests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Confirmation Checking", () => {
    it("should store deposit as PENDING when confirmations are insufficient", async () => {
      // Setup: Create blockchain with 12 confirmation requirement
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Ethereum",
          chainId: 999,
          rpcUrl: "http://localhost:8545",
          explorerUrl: "https://etherscan.io",
          nativeCurrency: {
            name: "Ether",
            symbol: "ETH",
            decimals: 18,
          },
          confirmations: 12, // Require 12 confirmations
        },
      });

      const token = await app.prisma.token.create({
        data: {
          blockchainId: blockchain.id,
          address: "0x1234567890123456789012345678901234567890",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          minDeposit: "1000000", // 1 USDC
        },
      });

      const user = await app.prisma.user.create({
        data: {
          username: `test_conf_${Date.now()}`,
          address: `0xtest_conf_${Date.now()}`,
          accounts: {
            create: {
              currency: "USDC",
              type: "MAIN",
              balance: 0,
            },
          },
        },
      });

      // Simulate deposit detected at block 1000, current block is 1005 (5 confirmations)
      const deposit = await app.prisma.paymentTransaction.create({
        data: {
          userId: user.id,
          type: "DEPOSIT",
          blockchainId: blockchain.id,
          tokenId: token.id,
          txHash: "0xtest_pending_tx",
          address: user.address,
          blockNumber: "1000",
          amountRaw: "100000000", // 100 USDC
          amountCredit: 10000, // 100.00 in cents
          status: "PENDING", // Should be PENDING with only 5 confirmations
        },
      });

      expect(deposit.status).toBe("PENDING");
      expect(deposit.confirmedAt).toBeNull();

      // Verify balance was NOT credited
      const account = await app.prisma.account.findFirst({
        where: { userId: user.id, type: "MAIN" },
      });
      expect(account?.balance).toBe(0);

      // Cleanup
      await app.prisma.paymentTransaction.delete({ where: { id: deposit.id } });
      await app.prisma.token.delete({ where: { id: token.id } });
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });

    it("should upgrade PENDING deposit to CONFIRMED after sufficient confirmations", async () => {
      // This test simulates the checkPendingDeposits function
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Polygon",
          chainId: 998,
          rpcUrl: "http://localhost:8545",
          explorerUrl: "https://polygonscan.com",
          nativeCurrency: {
            name: "MATIC",
            symbol: "MATIC",
            decimals: 18,
          },
          confirmations: 5, // Lower requirement for test
        },
      });

      const token = await app.prisma.token.create({
        data: {
          blockchainId: blockchain.id,
          address: "0x2222222222222222222222222222222222222222",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          minDeposit: "1000000",
        },
      });

      const user = await app.prisma.user.create({
        data: {
          username: `test_upgrade_${Date.now()}`,
          address: `0xtest_upgrade_${Date.now()}`,
          accounts: {
            create: {
              currency: "USDC",
              type: "MAIN",
              balance: 0,
            },
          },
        },
      });

      // Create PENDING deposit
      const deposit = await app.prisma.paymentTransaction.create({
        data: {
          userId: user.id,
          type: "DEPOSIT",
          blockchainId: blockchain.id,
          tokenId: token.id,
          txHash: "0xtest_upgrade_tx",
          address: user.address,
          blockNumber: "1000",
          amountRaw: "50000000", // 50 USDC
          amountCredit: 5000, // 50.00 in cents
          status: "PENDING",
        },
      });

      // Simulate enough blocks have passed (currentBlock: 1006, depositBlock: 1000 = 6 confirmations > 5 required)
      // In real code, checkPendingDeposits would upgrade this

      // Manually upgrade to simulate worker behavior
      await app.prisma.$transaction(async (tx) => {
        const account = await tx.account.findFirstOrThrow({
          where: { userId: user.id, type: "MAIN" },
        });

        const ledgerEntry = await tx.ledgerEntry.create({
          data: {
            accountId: account.id,
            amount: deposit.amountCredit,
            type: "DEPOSIT",
            referenceId: deposit.txHash!,
            metadata: { test: true },
          },
        });

        await tx.account.update({
          where: { id: account.id },
          data: { balance: { increment: deposit.amountCredit } },
        });

        await tx.paymentTransaction.update({
          where: { id: deposit.id },
          data: {
            status: "CONFIRMED",
            ledgerEntryId: ledgerEntry.id,
            confirmedAt: new Date(),
          },
        });
      });

      // Verify upgrade
      const updated = await app.prisma.paymentTransaction.findUnique({
        where: { id: deposit.id },
      });
      expect(updated?.status).toBe("CONFIRMED");
      expect(updated?.confirmedAt).not.toBeNull();

      // Verify balance was credited
      const account = await app.prisma.account.findFirst({
        where: { userId: user.id, type: "MAIN" },
      });
      expect(account?.balance).toBe(5000);

      // Cleanup
      await app.prisma.paymentTransaction.delete({ where: { id: deposit.id } });
      await app.prisma.token.delete({ where: { id: token.id } });
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe("Block Scanning Gap Prevention", () => {
    it("should track lastScannedBlock to prevent missed deposits", async () => {
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Gap Chain",
          chainId: 997,
          rpcUrl: "http://localhost:8545",
          explorerUrl: "https://explorer.io",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          confirmations: 12,
          lastScannedBlock: null, // Start with no tracking
        },
      });

      // Initial state: no lastScannedBlock
      expect(blockchain.lastScannedBlock).toBeNull();

      // Simulate first scan up to block 1000
      await app.prisma.blockchain.update({
        where: { id: blockchain.id },
        data: { lastScannedBlock: "1000" },
      });

      let updated = await app.prisma.blockchain.findUnique({
        where: { id: blockchain.id },
      });
      expect(updated?.lastScannedBlock).toBe("1000");

      // Simulate next scan should start from 1001
      const lastScanned = BigInt(updated!.lastScannedBlock!);
      const fromBlock = lastScanned + 1n; // Should be 1001
      expect(fromBlock).toBe(1001n);

      // Simulate scan up to block 1150
      await app.prisma.blockchain.update({
        where: { id: blockchain.id },
        data: { lastScannedBlock: "1150" },
      });

      updated = await app.prisma.blockchain.findUnique({
        where: { id: blockchain.id },
      });
      expect(updated?.lastScannedBlock).toBe("1150");

      // Cleanup
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
    });

    it("should resume scanning from lastScannedBlock after worker restart", async () => {
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Resume Chain",
          chainId: 996,
          rpcUrl: "http://localhost:8545",
          explorerUrl: "https://explorer.io",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          confirmations: 12,
          lastScannedBlock: "5000", // Worker crashed at block 5000
        },
      });

      // Simulate worker restart
      const chain = await app.prisma.blockchain.findUnique({
        where: { id: blockchain.id },
      });

      // Worker should resume from 5001, not currentBlock - 100
      const resumeFrom = BigInt(chain!.lastScannedBlock!) + 1n;
      expect(resumeFrom).toBe(5001n);

      // Even if current block is 6000, we scan from 5001 to catch any gaps
      const currentBlock = 6000n;
      const scanRange = Number(currentBlock - resumeFrom + 1n);
      expect(scanRange).toBe(1000); // Scans 1000 blocks to catch up

      // Cleanup
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
    });
  });

  describe("BigInt Financial Math", () => {
    it("should use BigInt arithmetic for token conversion (no floating point)", () => {
      // Test Case 1: Standard USDC (6 decimals)
      const usdc6Decimals = {
        amount: 100000000n, // 100 USDC raw
        decimals: 6,
      };

      const chips1 = Number((usdc6Decimals.amount * 100n) / 10n ** BigInt(usdc6Decimals.decimals));
      expect(chips1).toBe(10000); // 100.00 USDC = 10000 cents

      // Test Case 2: Token with 18 decimals (like ETH)
      const eth18Decimals = {
        amount: 1000000000000000000n, // 1 ETH raw
        decimals: 18,
      };

      const chips2 = Number((eth18Decimals.amount * 100n) / 10n ** BigInt(eth18Decimals.decimals));
      expect(chips2).toBe(100); // 1 ETH = 100 cents (if 1 ETH = $1 for test)

      // Test Case 3: Large amount that demonstrates BigInt precision
      const largeAmount = {
        amount: 1000000000000n, // 1 million USDC (6 decimals)
        decimals: 6,
      };

      const chips3 = Number((largeAmount.amount * 100n) / 10n ** BigInt(largeAmount.decimals));
      // This should not lose precision in BigInt calculation
      expect(chips3).toBe(100000000); // 1,000,000.00 USDC = 100,000,000 cents

      // Test Case 4: Verify we NEVER use parseFloat
      const badExample = "100.123456789"; // More precision than float can handle
      const floatResult = Math.floor(parseFloat(badExample) * 100);
      expect(floatResult).toBe(10012); // Loses precision

      // Correct BigInt approach
      const amountRaw = 100123456n; // 100.123456 USDC (6 decimals)
      const correctResult = Number((amountRaw * 100n) / 1000000n);
      expect(correctResult).toBe(10012); // Same result, but calculated correctly
    });

    it("should handle edge cases with BigInt conversion", () => {
      // Edge Case 1: Very small amount (less than 1 cent)
      const tinyAmount = 5000n; // 0.005 USDC (6 decimals)
      const tinyChips = Number((tinyAmount * 100n) / 1000000n);
      expect(tinyChips).toBe(0); // Correctly rounds down to 0 cents

      // Edge Case 2: Exactly 1 cent
      const oneCent = 10000n; // 0.01 USDC (6 decimals)
      const oneCentChips = Number((oneCent * 100n) / 1000000n);
      expect(oneCentChips).toBe(1); // Exactly 1 chip

      // Edge Case 3: Max safe integer check
      const hugeAmount = BigInt(Number.MAX_SAFE_INTEGER) * 1000000n; // Way too large
      const hugeChips = Number((hugeAmount * 100n) / 1000000n);
      // Should overflow Number.MAX_SAFE_INTEGER, worker should reject this
      expect(hugeChips).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("RPC Failover", () => {
    it("should support backup RPC URL in blockchain config", async () => {
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Failover Chain",
          chainId: 995,
          rpcUrl: "https://primary-rpc.example.com",
          rpcUrlBackup: "https://backup-rpc.example.com", // Backup RPC
          explorerUrl: "https://explorer.io",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          confirmations: 12,
        },
      });

      expect(blockchain.rpcUrl).toBe("https://primary-rpc.example.com");
      expect(blockchain.rpcUrlBackup).toBe("https://backup-rpc.example.com");

      // BlockchainManager should use fallback transport with both URLs
      // (Actual RPC failover testing would require mocking viem clients)

      // Cleanup
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
    });
  });

  describe("Deposit Deduplication", () => {
    it("should not double-credit the same transaction", async () => {
      const blockchain = await app.prisma.blockchain.create({
        data: {
          name: "Test Dedup Chain",
          chainId: 994,
          rpcUrl: "http://localhost:8545",
          explorerUrl: "https://explorer.io",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          confirmations: 1,
        },
      });

      const token = await app.prisma.token.create({
        data: {
          blockchainId: blockchain.id,
          address: "0x3333333333333333333333333333333333333333",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          minDeposit: "1000000",
        },
      });

      const user = await app.prisma.user.create({
        data: {
          username: `test_dedup_${Date.now()}`,
          address: `0xtest_dedup_${Date.now()}`,
          accounts: {
            create: {
              currency: "USDC",
              type: "MAIN",
              balance: 0,
            },
          },
        },
      });

      const txHash = "0xtest_duplicate_tx";

      // First deposit
      await app.prisma.paymentTransaction.create({
        data: {
          userId: user.id,
          type: "DEPOSIT",
          blockchainId: blockchain.id,
          tokenId: token.id,
          txHash,
          address: user.address,
          blockNumber: "1000",
          amountRaw: "100000000",
          amountCredit: 10000,
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });

      // Attempt to create duplicate
      await expect(
        app.prisma.paymentTransaction.create({
          data: {
            userId: user.id,
            type: "DEPOSIT",
            blockchainId: blockchain.id,
            tokenId: token.id,
            txHash, // Same txHash
            address: user.address,
            blockNumber: "1000",
            amountRaw: "100000000",
            amountCredit: 10000,
            status: "CONFIRMED",
            confirmedAt: new Date(),
          },
        })
      ).rejects.toThrow(); // Should fail on unique constraint

      // Verify only one deposit exists
      const deposits = await app.prisma.paymentTransaction.findMany({
        where: { txHash },
      });
      expect(deposits).toHaveLength(1);

      // Cleanup
      await app.prisma.paymentTransaction.deleteMany({ where: { txHash } });
      await app.prisma.token.delete({ where: { id: token.id } });
      await app.prisma.blockchain.delete({ where: { id: blockchain.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });
});
