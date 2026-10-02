/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { BalanceSchema, AssetSchema } from "@pokertools/types";
import { initTestContext, runCleanup, type TestContext } from "../helpers/test-utils.js";

/**
 * Canonical finance route surface.
 *
 * The legacy custodial deposit/session routes (and the cents blockchain/token
 * list) were removed. They must be gone (404) and the canonical asset/balance
 * projection must remain guarded by authentication.
 */
describe("Canonical Finance Routes", () => {
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
    await runCleanup(context.cleanup);
  });

  describe("removed legacy routes", () => {
    it("GET /finance/chains is gone", async () => {
      const response = await app.inject({ method: "GET", url: "/finance/chains" });
      expect(response.statusCode).toBe(404);
    });

    it("POST /finance/deposit/start is gone", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/finance/deposit/start",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it("GET /finance/deposit/address is gone", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposit/address",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it("GET /finance/deposits (legacy list) is gone", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/deposits",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("canonical asset registry", () => {
    it("serves only canonical strict asset metadata", async () => {
      const response = await app.inject({ method: "GET", url: "/finance/assets" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { assets: unknown[] };
      expect(Array.isArray(body.assets)).toBe(true);
      for (const asset of body.assets) {
        const parsed = AssetSchema.parse(asset);
        expect(parsed).not.toHaveProperty("treasuryAddress");
        expect(parsed).not.toHaveProperty("rpcUrls");
      }
    });
  });

  describe("canonical balances", () => {
    it("requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/finance/balances" });
      expect(response.statusCode).toBe(401);
    });

    it("returns the authenticated principal's canonical atomic balances", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/finance/balances",
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { principalId: string; balances: unknown[] };
      expect(body.principalId).toBe(userId);
      expect(Array.isArray(body.balances)).toBe(true);
      for (const balance of body.balances) BalanceSchema.parse(balance);
    });
  });
});
