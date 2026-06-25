/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BlockchainManager } from "../../src/services/BlockchainManager.js";
import { encryptXpub } from "../../src/utils/crypto.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

describe("BlockchainManager", () => {
  let blockchainManager: BlockchainManager;
  let mockPrisma: any;

  // Generate a valid xPub (not xPriv) for testing xpub-only derivation
  const getTestXpub = () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const seed = mnemonicToSeedSync(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    const derivedKey = masterKey.derive("m/44'/60'/0'/0");
    return derivedKey.publicExtendedKey; // xPub only - no private key exposure
  };

  beforeEach(() => {
    // Create mock Prisma client
    mockPrisma = {
      blockchain: {
        findUniqueOrThrow: vi.fn(),
        findMany: vi.fn(),
      },
      adminWallet: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      userWallet: {
        findFirst: vi.fn(),
        create: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      depositSession: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    blockchainManager = new BlockchainManager(mockPrisma);
    vi.clearAllMocks();
  });

  describe("getUserDepositAddress", () => {
    it("should return existing address if user already has wallet", async () => {
      const userId = "user_123";
      const existingAddress = "0x1234567890123456789012345678901234567890";

      mockPrisma.userWallet.findFirst.mockResolvedValue({
        id: "wallet_1",
        userId,
        address: existingAddress,
        derivationIndex: 0,
        adminWallet: { isActive: true },
      });

      const address = await blockchainManager.getUserDepositAddress(userId);

      expect(address).toBe(existingAddress);
      expect(mockPrisma.userWallet.findFirst).toHaveBeenCalledWith({
        where: { userId, adminWallet: { isActive: true } },
        include: { adminWallet: true },
      });
    });

    it("should create new wallet if user doesn't have one, using xpub-only derivation", async () => {
      const userId = "user_456";
      const testXpub = getTestXpub(); // xPub only - no private key
      const encryptedXpub = encryptXpub(testXpub);

      mockPrisma.userWallet.findFirst.mockResolvedValue(null);
      mockPrisma.adminWallet.findFirst.mockResolvedValue({
        id: "admin_wallet_1",
        xpub: encryptedXpub,
        currentIndex: 5,
        isActive: true,
      });

      mockPrisma.$transaction.mockImplementation(async (callback: any) => {
        mockPrisma.adminWallet.update.mockResolvedValue({
          id: "admin_wallet_1",
          xpub: encryptedXpub,
          currentIndex: 6,
        });

        mockPrisma.userWallet.create.mockResolvedValue({
          id: "new_wallet",
          userId,
          address: "0x1234567890abcdef1234567890abcdef12345678", // Placeholder
          derivationIndex: 6,
        });

        return callback(mockPrisma);
      });

      const address = await blockchainManager.getUserDepositAddress(userId);

      expect(address).toBeTruthy();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/); // Valid Ethereum address
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("should throw error if no active admin wallet exists", async () => {
      const userId = "user_789";

      mockPrisma.userWallet.findFirst.mockResolvedValue(null);
      mockPrisma.adminWallet.findFirst.mockResolvedValue(null);

      await expect(blockchainManager.getUserDepositAddress(userId)).rejects.toThrow(
        "No active deposit wallet configured"
      );
    });
  });

  describe("startDepositSession", () => {
    it("should create deposit session with correct expiry", async () => {
      const userId = "user_123";
      const address = "0x1234567890123456789012345678901234567890";

      mockPrisma.userWallet.findFirst.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      mockPrisma.userWallet.findFirstOrThrow.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      // No existing active session
      mockPrisma.depositSession.findFirst.mockResolvedValue(null);

      mockPrisma.depositSession.create.mockResolvedValue({
        id: "session_1",
        userId,
        userWalletId: "wallet_1",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      });

      const result = await blockchainManager.startDepositSession(userId);

      expect(result.address).toBe(address);
      expect(result.expiresAt).toBeInstanceOf(Date);

      const expiryTime = result.expiresAt.getTime() - Date.now();
      expect(expiryTime).toBeGreaterThan(29 * 60 * 1000); // At least 29 minutes
      expect(expiryTime).toBeLessThan(31 * 60 * 1000); // At most 31 minutes
    });

    it("should extend existing session instead of creating new one", async () => {
      const userId = "user_123";
      const address = "0x1234567890123456789012345678901234567890";

      mockPrisma.userWallet.findFirst.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      mockPrisma.userWallet.findFirstOrThrow.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      // Existing active session found
      mockPrisma.depositSession.findFirst.mockResolvedValue({
        id: "session_existing",
        userId,
        userWalletId: "wallet_1",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        createdAt: new Date(),
      });

      mockPrisma.depositSession.update.mockResolvedValue({
        id: "session_existing",
        userId,
        userWalletId: "wallet_1",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
      });

      const result = await blockchainManager.startDepositSession(userId);

      expect(result.address).toBe(address);
      // Should have called update, not create
      expect(mockPrisma.depositSession.update).toHaveBeenCalled();
      expect(mockPrisma.depositSession.create).not.toHaveBeenCalled();
    });

    it("should use custom duration when provided", async () => {
      const userId = "user_123";
      const address = "0x1234567890123456789012345678901234567890";
      const customDuration = 60; // 60 minutes

      mockPrisma.userWallet.findFirst.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      mockPrisma.userWallet.findFirstOrThrow.mockResolvedValue({
        id: "wallet_1",
        userId,
        address,
      });

      mockPrisma.depositSession.findFirst.mockResolvedValue(null);

      mockPrisma.depositSession.create.mockResolvedValue({
        id: "session_1",
        userId,
        userWalletId: "wallet_1",
        expiresAt: new Date(Date.now() + customDuration * 60 * 1000),
        createdAt: new Date(),
      });

      const result = await blockchainManager.startDepositSession(userId, customDuration);

      const expiryTime = result.expiresAt.getTime() - Date.now();
      expect(expiryTime).toBeGreaterThan(59 * 60 * 1000); // At least 59 minutes
      expect(expiryTime).toBeLessThan(61 * 60 * 1000); // At most 61 minutes
    });
  });

  describe("HD Wallet Derivation", () => {
    it("should generate unique addresses for different indices using xpub-only", async () => {
      const testXpub = getTestXpub(); // xPub only
      const encryptedXpub = encryptXpub(testXpub);

      // Mock two different users getting different addresses
      mockPrisma.userWallet.findFirst
        .mockResolvedValueOnce(null) // User 1 - no wallet
        .mockResolvedValueOnce(null); // User 2 - no wallet

      mockPrisma.adminWallet.findFirst.mockResolvedValue({
        id: "admin_wallet_1",
        xpub: encryptedXpub,
        currentIndex: 0,
        isActive: true,
      });

      const addresses: string[] = [];

      for (let i = 0; i < 2; i++) {
        mockPrisma.$transaction.mockImplementation(async (callback: any) => {
          mockPrisma.adminWallet.update.mockResolvedValue({
            id: "admin_wallet_1",
            xpub: encryptedXpub,
            currentIndex: i + 1,
          });

          mockPrisma.userWallet.create.mockImplementation((data: any) => {
            return Promise.resolve({
              ...data.data,
              id: `wallet_${i}`,
            });
          });

          return callback(mockPrisma);
        });

        const address = await blockchainManager.getUserDepositAddress(`user_${i}`);
        addresses.push(address);
      }

      // Verify addresses are different
      expect(addresses[0]).not.toBe(addresses[1]);
      // Verify both are valid Ethereum addresses
      expect(addresses[0]).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(addresses[1]).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("should derive addresses from xpub without requiring private key", () => {
      const testXpub = getTestXpub(); // xPub only
      const hdKey = HDKey.fromExtendedKey(testXpub);

      // Verify this is indeed a public-only key (no private key)
      expect(hdKey.privateKey).toBeNull();
      expect(hdKey.publicKey).not.toBeNull();

      // Derive a child and get an address (this should NOT throw)
      const childKey = hdKey.deriveChild(0);
      expect(childKey.publicKey).not.toBeNull();
      // Address derivation from public key should work without private key
    });
  });
});
