import { describe, it, expect, vi } from "vitest";
import {
  createSiweMessage as maintainedFormatter,
  parseSiweMessage as maintainedParser,
} from "viem/siwe";
import {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalTypedData,
  signWithdrawalIntent,
  generateIdempotencyKey,
} from "../src/auth";

describe("Auth Utilities", () => {
  describe("createSiweMessage", () => {
    it("delegates formatting and parsing of every optional field to viem", () => {
      const params = {
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" as const,
        uri: "https://poker.example.com",
        chainId: 31337,
        nonce: "abcdefgh1234",
        version: "1" as const,
        issuedAt: new Date("2026-01-01T00:00:00Z"),
        expirationTime: new Date("2027-01-01T00:00:00Z"),
        notBefore: new Date("2026-01-01T00:00:00Z"),
        requestId: "login-1",
        statement: "Sign in",
        resources: ["https://poker.example.com/tables"],
      };
      const message = createSiweMessage(params);
      expect(message).toBe(maintainedFormatter(params));
      expect(parseSiweMessage(message)).toEqual(maintainedParser(message));
      expect(parseSiweMessage(message).resources).toEqual(params.resources);
    });

    it("rejects malformed construction instead of producing non-standard messages", () => {
      const params = {
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" as const,
        uri: "https://poker.example.com",
        nonce: "abcdefgh1234",
      };
      for (const change of [
        { nonce: "short" },
        { uri: "not-a-uri" },
        { statement: "line\ninjection" },
        { issuedAt: "invalid" },
      ]) {
        expect(() => createSiweMessage({ ...params, ...change })).toThrow();
      }
      expect(isSiweExpired("not a SIWE message")).toBe(true);
    });
    it("creates a valid SIWE message with required fields", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
      });

      expect(message).toContain("poker.example.com wants you to sign in");
      expect(message).toContain("0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(message).toContain("URI: https://poker.example.com");
      expect(message).toContain("Nonce: abc12345");
      expect(message).toContain("Chain ID: 1");
      expect(message).toContain("Version: 1");
    });

    it("includes optional statement", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
        statement: "Sign in to PokerTools",
      });

      expect(message).toContain("Sign in to PokerTools");
    });

    it("includes custom chain ID", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
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
        nonce: "abc12345",
        expirationTime,
      });

      expect(message).toContain(`Expiration Time: ${expirationTime}`);
    });

    it("includes resources", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
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
        nonce: "abc12345",
        chainId: 1,
      });

      const parsed = parseSiweMessage(original);

      expect(parsed.domain).toBe("poker.example.com");
      expect(parsed.address).toBe("0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(parsed.uri).toBe("https://poker.example.com");
      expect(parsed.nonce).toBe("abc12345");
      expect(parsed.chainId).toBe(1);
      expect(parsed.version).toBe("1");
    });

    it("parses statement", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
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
        nonce: "abc12345",
      });

      expect(isSiweExpired(message)).toBe(false);
    });

    it("returns false for future expiration", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
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
        nonce: "abc12345",
        expirationTime: pastDate,
      });

      expect(isSiweExpired(message)).toBe(true);
    });
  });

  describe("canonical withdrawal EIP-712", () => {
    const intent = {
      intentId: "intent-1",
      principalId: "principal-1",
      assetId: "eip155:31337/erc20:0x5fbdb2315678afecb367f032d93f642f64180aa3" as const,
      destination: "0x742d35cc6634c0532925a3b844bc454e4438f44e" as const,
      amountAtomic: "1000000",
      nonce: 7,
      deadline: 1893456000,
      chainId: 31337,
    };
    const domain = {
      name: "PokerTools Withdrawal",
      version: "1",
      chainId: 31337,
      verifyingContract: "0x0000000000000000000000000000000000000000" as const,
    };

    it("builds canonical EIP-712 typed data for a withdrawal intent", () => {
      const typedData = createWithdrawalTypedData(intent, domain);
      expect(typedData.primaryType).toBe("WithdrawalIntent");
      expect(typedData.domain).toEqual(domain);
      expect(typedData.types.WithdrawalIntent.map((f) => f.name)).toEqual([
        "intentId",
        "principalId",
        "assetId",
        "destination",
        "amountAtomic",
        "nonce",
        "deadline",
        "chainId",
      ]);
      expect(typedData.message).toMatchObject(intent);
    });

    it("rejects a domain that does not match the fixed withdrawal contract", () => {
      expect(() =>
        createWithdrawalTypedData(intent, { ...domain, name: "Attacker Controlled" })
      ).toThrow();
      expect(() => createWithdrawalTypedData(intent, { ...domain, chainId: 1 })).toThrow();
    });

    it("signs the intent through a caller-supplied signer without inventing one", async () => {
      const typedData = createWithdrawalTypedData(intent, domain);
      const signTypedData = vi.fn(async () => `0x${"ab".repeat(65)}` as `0x${string}`);
      const submission = await signWithdrawalIntent({ signTypedData }, intent, domain);

      expect(signTypedData).toHaveBeenCalledWith({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      // The API rebuilds the signature input; clients never submit typed data.
      expect(submission).toEqual({ intent, signature: `0x${"ab".repeat(65)}` });
      expect("typedData" in submission).toBe(false);
    });

    it("rejects an invalid canonical intent (atomic amount must be a decimal string)", () => {
      expect(() =>
        createWithdrawalTypedData(
          { ...intent, amountAtomic: "1000000.5" } as unknown as typeof intent,
          domain
        )
      ).toThrow();
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
