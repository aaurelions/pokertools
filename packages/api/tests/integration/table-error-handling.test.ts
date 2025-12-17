/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { cleanupTestUser } from "../helpers/test-utils.js";

describe("Table Error Handling Test", () => {
  let app: FastifyInstance;
  let testUser: { id: string; address: string };
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create test user
    const randomId = Date.now();
    testUser = await app.prisma.user.create({
      data: {
        username: `test_errors_${randomId}`,
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

  it("should handle buy-in without idempotency key", async () => {
    // Create a table first
    const createResponse = await app.inject({
      method: "POST",
      url: "/tables",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        name: "Error Test Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const { tableId } = JSON.parse(createResponse.body);

    // Try to buy in without idempotency key
    const buyInResponse = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        amount: 1000,
        seat: 0,
        // Missing idempotencyKey
      },
    });

    expect(buyInResponse.statusCode).toBe(400);
    const body = JSON.parse(buyInResponse.body);
    expect(body.error).toContain("idempotencyKey");

    // Cleanup
    await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
  });

  it("should handle buy-in with insufficient funds", async () => {
    // Create user with low balance
    const randomId = Date.now();
    const poorUser = await app.prisma.user.create({
      data: {
        username: `poor_user_${randomId}`,
        address: `0xpoor${randomId}`,
        accounts: {
          create: [
            {
              currency: "USDC",
              type: "MAIN",
              balance: 100, // Only 100 chips
            },
          ],
        },
      },
    });

    const poorJti = `poor_jti_${randomId}`;
    const poorToken = await app.jwt.sign(
      { userId: poorUser.id, address: poorUser.address, jti: poorJti },
      { jti: poorJti, expiresIn: "1h" }
    );

    await app.prisma.session.create({
      data: {
        userId: poorUser.id,
        jti: poorJti,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    // Create table
    const createResponse = await app.inject({
      method: "POST",
      url: "/tables",
      headers: {
        authorization: `Bearer ${poorToken}`,
      },
      payload: {
        name: "Insufficient Funds Test",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const { tableId } = JSON.parse(createResponse.body);

    // Try to buy in with more than balance
    const buyInResponse = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${poorToken}`,
      },
      payload: {
        amount: 1000, // More than the 100 they have
        seat: 0,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    // Should fail with error (400 or 500)
    expect([400, 500]).toContain(buyInResponse.statusCode);
    const body = JSON.parse(buyInResponse.body);
    expect(body.error || body.message).toBeTruthy();

    // Cleanup
    await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
    await cleanupTestUser(app, poorUser.id);
  });

  it("should handle non-existent table", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/tables/non-existent-table-id",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("should handle invalid action on table", async () => {
    // Create table and sit
    const createResponse = await app.inject({
      method: "POST",
      url: "/tables",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        name: "Invalid Action Test",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const { tableId } = JSON.parse(createResponse.body);

    // Try invalid action without being seated
    const actionResponse = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/action`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        type: "FOLD",
      },
    });

    // Should return error (400 or 500 depending on engine validation)
    expect([400, 500]).toContain(actionResponse.statusCode);

    // Cleanup
    await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
  });

  it("should handle seat conflict (idempotency)", async () => {
    // Create table
    const createResponse = await app.inject({
      method: "POST",
      url: "/tables",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        name: "Seat Conflict Test",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const { tableId } = JSON.parse(createResponse.body);

    // Buy in at seat 0
    const idempotencyKey = crypto.randomUUID();
    const buyIn1 = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        amount: 1000,
        seat: 0,
        idempotencyKey,
      },
    });

    expect(buyIn1.statusCode).toBe(200);

    // Try same buy-in again with same idempotency key (should succeed idempotently)
    const buyIn2 = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        amount: 1000,
        seat: 0,
        idempotencyKey, // Same key
      },
    });

    expect(buyIn2.statusCode).toBe(200);

    // Cleanup
    await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
  });

  it("should require authentication for table creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tables",
      payload: {
        name: "Unauthorized Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should list tables without authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/tables",
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.tables).toBeDefined();
    expect(Array.isArray(data.tables)).toBe(true);
  });
});
