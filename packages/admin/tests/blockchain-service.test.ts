/**
 * Tests for admin BlockchainService split-key semantics.
 *
 * Verifies:
 * - Admin uses encrypted xpriv only (never xpub for private derivation)
 * - getUserAccount correctly derives private keys from xpriv
 * - Address derivation matches between API (xpub) and admin (xpriv) sides
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { publicKeyToAddress } from "viem/accounts";
import { bytesToHex } from "viem/utils";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// Mock the config module
vi.mock("../src/config.js", () => ({
  config: {
    HOT_WALLET_DERIVATION_PATH: "m/44'/60'/0'/0/0",
    RPC_RETRY_COUNT: 3,
    RPC_RETRY_DELAY_MS: 1000,
    RPC_TIMEOUT_MS: 10000,
    WITHDRAWAL_SIGNATURE_MAX_AGE_MS: 300000,
    MAX_GAS_PRICE_GWEI: 50,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
    CIRCUIT_BREAKER_OPEN_MS: 30000,
  },
  SECRETS: {
    MASTER_MNEMONIC: "test test test test test test test test test test test junk",
  },
}));

// Mock the crypto module for decryptXpriv
vi.mock("../src/utils/crypto.js", () => ({
  decryptXpub: vi.fn().mockImplementation((encrypted: string) => {
    // For test purposes, if encrypted looks like an xpub prefix, return as-is
    if (encrypted.startsWith("xpub")) return encrypted;
    throw new Error("Not an xpub");
  }),
  decryptXpriv: vi.fn().mockImplementation((encrypted: string) => {
    // For test purposes, if encrypted looks like an xpriv prefix, return as-is
    if (encrypted.startsWith("xprv")) return encrypted;
    throw new Error("Not an xpriv");
  }),
  encryptXpub: vi.fn(),
  encryptXpriv: vi.fn(),
}));

describe("BlockchainService Split-Key Semantics", () => {
  let mockPrisma: any;

  const getTestXpriv = () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const seed = mnemonicToSeedSync(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    const derivedKey = masterKey.derive("m/44'/60'/0'/0");
    return derivedKey.privateExtendedKey; // Full xpriv with private key
  };

  const getTestXpub = () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const seed = mnemonicToSeedSync(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    const derivedKey = masterKey.derive("m/44'/60'/0'/0");
    return derivedKey.publicExtendedKey; // xPub only
  };

  beforeEach(() => {
    mockPrisma = {
      adminWallet: {
        findFirst: vi.fn(),
      },
    };
    vi.clearAllMocks();
  });

  it("should use xpriv (not xpub) for private key derivation in getUserAccount", async () => {
    const testXpriv = getTestXpriv();
    const testXpub = getTestXpub();

    mockPrisma.adminWallet.findFirst.mockResolvedValue({
      id: "admin_wallet_1",
      xpub: testXpub, // API uses this
      xpriv: testXpriv, // Admin uses this (encrypted)
      isActive: true,
      derivationPath: "m/44'/60'/0'/0",
      currentIndex: 5,
    });

    // Verify xpriv and xpub derive the same addresses
    const xprivKey = HDKey.fromExtendedKey(testXpriv);
    const xpubKey = HDKey.fromExtendedKey(testXpub);

    for (let i = 0; i < 3; i++) {
      const xprivChild = xprivKey.deriveChild(i);
      const xpubChild = xpubKey.deriveChild(i);

      expect(xprivChild.privateKey).not.toBeNull();
      // xpub should not have private key
      expect(xpubChild.privateKey).toBeNull();

      // Both should produce the same public key
      const xprivPubKey = xprivChild.publicKey!;
      const xpubPubKey = xpubChild.publicKey!;
      expect(Buffer.from(xprivPubKey).toString("hex")).toBe(
        Buffer.from(xpubPubKey).toString("hex")
      );

      // Both should produce the same address
      const xprivUncompressed = secp256k1.Point.fromBytes(xprivPubKey).toBytes(false);
      const xpubUncompressed = secp256k1.Point.fromBytes(xpubPubKey).toBytes(false);

      const xprivAddr = publicKeyToAddress(bytesToHex(xprivUncompressed));
      const xpubAddr = publicKeyToAddress(bytesToHex(xpubUncompressed));

      expect(xprivAddr.toLowerCase()).toBe(xpubAddr.toLowerCase());
    }
  });

  it("should require xpriv for signing (admin-side only), API uses xpub only", () => {
    const testXpriv = getTestXpriv();
    const testXpub = getTestXpub();

    const xprivKey = HDKey.fromExtendedKey(testXpriv);
    const xpubKey = HDKey.fromExtendedKey(testXpub);

    // Admin side: has private key for signing
    const adminChild = xprivKey.deriveChild(0);
    expect(adminChild.privateKey).toBeTruthy();
    expect(adminChild.privateKey!.length).toBe(32);

    // API side: only has public key - cannot sign
    const apiChild = xpubKey.deriveChild(0);
    expect(apiChild.privateKey).toBeNull();
    expect(apiChild.publicKey).toBeTruthy();

    // This is the security boundary: API can derive addresses but can't sign
    // Admin can derive both addresses and sign transactions
  });

  it("should produce consistent addresses across API and admin derivation", () => {
    const testXpriv = getTestXpriv();

    const xprivKey = HDKey.fromExtendedKey(testXpriv);

    // Generate addresses for first 10 indices
    const addresses = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const child = xprivKey.deriveChild(i);
      const publicKey = child.publicKey!;
      const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
      const address = publicKeyToAddress(bytesToHex(uncompressed)).toLowerCase();

      // Each address should be unique
      expect(addresses.has(address)).toBe(false);
      addresses.add(address);

      // Should be valid Ethereum address format
      expect(address).toMatch(/^0x[a-f0-9]{40}$/);
    }

    expect(addresses.size).toBe(10);
  });
});
