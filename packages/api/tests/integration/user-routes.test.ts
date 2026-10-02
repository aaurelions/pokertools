/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { BalanceSchema } from "@pokertools/types";
import { cleanupTestUser } from "../helpers/test-utils.js";

describe("User Routes Test", () => {
  let app: FastifyInstance;
  let testUser: { id: string; address: string };
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const randomId = Date.now();
    testUser = await app.prisma.user.create({
      data: {
        username: `test_user_${randomId}`,
        address: `0x${randomId.toString(16).padStart(40, "0").slice(-40)}`,
        kind: "WALLET",
      },
    });

    const jti = `test_jti_${randomId}`;
    token = await app.jwt.sign(
      { userId: testUser.id, address: testUser.address, jti },
      { jti, expiresIn: "1h" }
    );

    await app.prisma.session.create({
      data: {
        userId: testUser.id,
        jti,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  });

  afterAll(async () => {
    await cleanupTestUser(app, testUser.id);
    await app.close();
  });

  it("serves the canonical chip/asset profile projection (no cents default)", async () => {
    await app.financialManager.grantChips(testUser.id, 100, {
      reason: "test-fixture",
      operatorId: testUser.id,
      idempotencyKey: `fixture-grant-${testUser.id}`,
    });

    const response = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);

    expect(data.id).toBe(testUser.id);
    expect(data.address).toBe(testUser.address);
    // Chips are integer gameplay units as decimal strings.
    expect(data.chipBalances).toBeDefined();
    expect(data.chipBalances.available).toBe("100");
    expect(data.chipBalances.pendingWithdrawal).toBe("0");
    // Atomic asset balances are a separate, canonical multi-asset projection.
    expect(Array.isArray(data.assetBalances)).toBe(true);
    for (const balance of data.assetBalances) BalanceSchema.parse(balance);
    // No legacy cents/default-currency balance view.
    expect(data.balances).toBeUndefined();
  });

  it("returns canonical chip journal history as decimal strings", async () => {
    await app.financialManager.grantChips(testUser.id, 250, {
      reason: "history-fixture",
      operatorId: testUser.id,
      idempotencyKey: `fixture-history-${testUser.id}`,
    });

    const response = await app.inject({
      method: "GET",
      url: "/user/history",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(Array.isArray(data.history)).toBe(true);
    expect(data.history.length).toBeGreaterThan(0);

    const entry = data.history[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("amount");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("referenceId");
    expect(entry).toHaveProperty("createdAt");
    // Canonical chip strings, never JS-number cents.
    expect(typeof entry.amount).toBe("string");
    expect(entry.amount).toMatch(/^-?[0-9]+$/);
  });

  it("should require authentication for protected routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/me",
    });

    expect(response.statusCode).toBe(401);
  });

  it("should reject invalid tokens", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: {
        authorization: "Bearer invalid_token_12345",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
