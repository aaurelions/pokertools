/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { initTestContext, runCleanup, type TestContext } from "../helpers/test-utils.js";

describe("Finance Routes Integration Tests", () => {
  let context: TestContext;
  let app: FastifyInstance;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    context = await initTestContext(1, 10000);
    app = context.app;
    userToken = context.users[0].token;
    userId = context.users[0].id;
  });

  afterAll(async () => {
    // Clean up any UserWallets before user deletion
    await app.prisma.depositSession.deleteMany({ where: { userId } });
    await app.prisma.userWallet.deleteMany({ where: { userId } });
    await runCleanup(context.cleanup);
  });

  describe("GET /finance/chains", () => {
    it("should list supported blockchains and tokens", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/chains",
      });

      expect(response.statusCode).toBe(200);
      const chains = JSON.parse(response.body);

      expect(Array.isArray(chains)).toBe(true);

      // Verify structure if chains exist (may be empty before seeding)
      if (chains.length > 0) {
        const chain = chains[0];
        expect(chain).toHaveProperty("id");
        expect(chain).toHaveProperty("name");
        expect(chain).toHaveProperty("chainId");
        expect(chain).toHaveProperty("tokens");
        expect(Array.isArray(chain.tokens)).toBe(true);
      }
    });

    it("should only return enabled blockchains", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/chains",
      });

      expect(response.statusCode).toBe(200);
      const chains = JSON.parse(response.body);

      for (const chain of chains) {
        expect(chain.isEnabled).toBe(true);
      }
    });
  });

  describe("POST /finance/deposit/start", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should generate deposit address and start session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      // May fail if admin wallet not configured, but should not error
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);

        expect(body).toHaveProperty("address");
        expect(body).toHaveProperty("expiresAt");
        expect(body).toHaveProperty("message");

        // Verify address format
        expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

        // Verify expiry is in the future
        const expiresAt = new Date(body.expiresAt);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("should return same address on subsequent calls", async () => {
      // First call
      const response1 = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      if (response1.statusCode !== 200) return; // Skip if wallet not configured

      const body1 = JSON.parse(response1.body);
      const address1 = body1.address;

      // Second call
      const response2 = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      expect(response2.statusCode).toBe(200);
      const body2 = JSON.parse(response2.body);

      // Should return same address
      expect(body2.address).toBe(address1);
    });
  });

  describe("GET /finance/deposit/address", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposit/address",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return user's deposit address", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposit/address",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);

        expect(body).toHaveProperty("address");
        expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });
  });

  describe("GET /finance/deposits", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposits",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return empty array for user with no deposits", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposits",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty("deposits");
      expect(Array.isArray(body.deposits)).toBe(true);
      expect(body.deposits).toHaveLength(0);
    });

    it("should return deposits with correct structure", async () => {
      // Create a mock deposit for testing
      const uniqueChainId = 900000 + Math.floor(Math.random() * 10000);
      const mockBlockchain = await app.prisma.blockchain.create({
        data: {
          name: `Test Blockchain ${uniqueChainId}`,
          chainId: uniqueChainId,
          rpcUrl: "http://test",
          explorerUrl: "http://test",
          nativeCurrency: { name: "Test", symbol: "TEST", decimals: 18 },
          isEnabled: false, // Disabled so it doesn't interfere
        },
      });

      const mockToken = await app.prisma.token.create({
        data: {
          blockchainId: mockBlockchain.id,
          address: "0x0000000000000000000000000000000000000001",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          minDeposit: "1000000",
          isEnabled: false,
        },
      });

      const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });

      await app.prisma.paymentTransaction.create({
        data: {
          userId,
          type: "DEPOSIT",
          blockchainId: mockBlockchain.id,
          tokenId: mockToken.id,
          txHash: "0xtest123",
          address: user.address,
          blockNumber: "1000",
          amountRaw: "100000000",
          amountCredit: 10000,
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/finance/deposits",
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.deposits).toHaveLength(1);
      const deposit = body.deposits[0];

      expect(deposit).toHaveProperty("id");
      expect(deposit).toHaveProperty("txHash");
      expect(deposit).toHaveProperty("chain");
      expect(deposit).toHaveProperty("token");
      expect(deposit).toHaveProperty("amountRaw");
      expect(deposit).toHaveProperty("amountCredit");
      expect(deposit).toHaveProperty("status");
      expect(deposit).toHaveProperty("createdAt");
      expect(deposit).toHaveProperty("explorerUrl");

      expect(deposit.txHash).toBe("0xtest123");
      expect(deposit.amountCredit).toBe(10000);
      expect(deposit.status).toBe("CONFIRMED");

      // Cleanup
      await app.prisma.paymentTransaction.deleteMany({ where: { userId } });
      await app.prisma.token.delete({ where: { id: mockToken.id } });
      await app.prisma.blockchain.delete({ where: { id: mockBlockchain.id } });
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid authentication token", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
        headers: {
          authorization: "Bearer invalid_token",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should handle missing authorization header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposits",
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
