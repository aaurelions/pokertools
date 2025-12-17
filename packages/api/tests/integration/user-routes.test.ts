/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { cleanupTestUser } from "../helpers/test-utils.js";

describe("User Routes Test", () => {
  let app: FastifyInstance;
  let testUser: { id: string; address: string };
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create test user and token
    const randomId = Date.now();
    testUser = await app.prisma.user.create({
      data: {
        username: `test_user_${randomId}`,
        address: `0xtest${randomId}`,
        accounts: {
          create: [
            {
              currency: "USDC",
              type: "MAIN",
              balance: 10000,
            },
          ],
        },
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

  it("should get user balances", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.id).toBe(testUser.id);
    expect(data.address).toBe(testUser.address);
    expect(data.balances).toBeDefined();
    expect(data.balances.main).toBe(10000);
  });

  it("should get transaction history", async () => {
    // Create some ledger entries for testing
    const account = await app.prisma.account.findFirstOrThrow({
      where: {
        userId: testUser.id,
        type: "MAIN",
      },
    });

    await app.prisma.ledgerEntry.createMany({
      data: [
        {
          accountId: account.id,
          amount: 100,
          type: "HAND_WIN",
          referenceId: "hand_1",
        },
        {
          accountId: account.id,
          amount: -50,
          type: "HAND_LOSS",
          referenceId: "hand_2",
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/user/history",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.history).toBeDefined();
    expect(Array.isArray(data.history)).toBe(true);
    expect(data.history.length).toBeGreaterThan(0);

    // Check structure of history entries
    const entry = data.history[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("amount");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("referenceId");
    expect(entry).toHaveProperty("createdAt");
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
