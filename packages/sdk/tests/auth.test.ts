import { describe, it, expect } from "vitest";
import {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalMessage,
  generateIdempotencyKey,
} from "../src/auth";

describe("Auth Utilities", () => {
  describe("createSiweMessage", () => {
    it("creates a valid SIWE message with required fields", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
      });

      expect(message).toContain("poker.example.com wants you to sign in");
      expect(message).toContain("0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(message).toContain("URI: https://poker.example.com");
      expect(message).toContain("Nonce: abc123");
      expect(message).toContain("Chain ID: 1");
      expect(message).toContain("Version: 1");
    });

    it("includes optional statement", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        statement: "Sign in to PokerTools",
      });

      expect(message).toContain("Sign in to PokerTools");
    });

    it("includes custom chain ID", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        chainId: 137,
      });

      expect(message).toContain("Chain ID: 137");
    });

    it("includes expiration time", () => {
      const expirationTime = "2024-12-31T23:59:59.999Z";
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        expirationTime,
      });

      expect(message).toContain(`Expiration Time: ${expirationTime}`);
    });

    it("includes resources", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        resources: ["https://poker.example.com/tables", "https://poker.example.com/user"],
      });

      expect(message).toContain("Resources:");
      expect(message).toContain("- https://poker.example.com/tables");
      expect(message).toContain("- https://poker.example.com/user");
    });
  });

  describe("parseSiweMessage", () => {
    it("parses a SIWE message correctly", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        chainId: 1,
      });

      const parsed = parseSiweMessage(original);

      expect(parsed.domain).toBe("poker.example.com");
      expect(parsed.address).toBe("0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(parsed.uri).toBe("https://poker.example.com");
      expect(parsed.nonce).toBe("abc123");
      expect(parsed.chainId).toBe(1);
      expect(parsed.version).toBe("1");
    });

    it("parses statement", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        statement: "Sign in to PokerTools",
      });

      const parsed = parseSiweMessage(original);
      expect(parsed.statement).toBe("Sign in to PokerTools");
    });
  });

  describe("isSiweExpired", () => {
    it("returns false for non-expiring message", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
      });

      expect(isSiweExpired(message)).toBe(false);
    });

    it("returns false for future expiration", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        expirationTime: futureDate,
      });

      expect(isSiweExpired(message)).toBe(false);
    });

    it("returns true for past expiration", () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc123",
        expirationTime: pastDate,
      });

      expect(isSiweExpired(message)).toBe(true);
    });
  });

  describe("createWithdrawalMessage", () => {
    it("creates correct withdrawal message", () => {
      const message = createWithdrawalMessage(100, "0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(message).toBe("Withdraw 100 USD to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
    });

    it("handles decimal amounts", () => {
      const message = createWithdrawalMessage(99.99, "0x123");
      expect(message).toBe("Withdraw 99.99 USD to 0x123");
    });
  });

  describe("generateIdempotencyKey", () => {
    it("generates unique keys", () => {
      const key1 = generateIdempotencyKey();
      const key2 = generateIdempotencyKey();
      expect(key1).not.toBe(key2);
    });

    it("generates non-empty strings", () => {
      const key = generateIdempotencyKey();
      expect(key.length).toBeGreaterThan(0);
    });
  });
});

