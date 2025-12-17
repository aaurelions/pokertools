/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  cleanupTestUser,
  createTable,
  buyIn,
  executeAction,
  getTableState,
} from "../helpers/test-utils.js";

describe("Table Action Validation Integration Test", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;
  let tableId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create user & token manually
    const randomId = Date.now();
    const user = await app.prisma.user.create({
      data: {
        username: `validation_${randomId}`,
        address: `0xval${randomId}`,
        accounts: {
          create: [{ currency: "USDC", type: "MAIN", balance: 10000 }],
        },
      },
    });
    userId = user.id;

    const jti = `jti_${randomId}`;
    token = await app.jwt.sign({ userId, address: user.address, jti }, { jti, expiresIn: "1h" });
    await app.prisma.session.create({
      data: { userId, jti, expiresAt: new Date(Date.now() + 3600000) },
    });

    // Create table
    tableId = await createTable(app, token, {
      name: "Validation Test",
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
    });

    // Buy in user 1
    await buyIn(app, token, tableId, 1000, 0);

    // Create user 2 & token
    const randomId2 = Date.now() + 1;
    const user2 = await app.prisma.user.create({
      data: {
        username: `validation_2_${randomId2}`,
        address: `0xval2_${randomId2}`,
        accounts: {
          create: [{ currency: "USDC", type: "MAIN", balance: 10000 }],
        },
      },
    });
    const jti2 = `jti_2_${randomId2}`;
    const token2 = await app.jwt.sign(
      { userId: user2.id, address: user2.address, jti: jti2 },
      { jti: jti2, expiresIn: "1h" }
    );
    await app.prisma.session.create({
      data: { userId: user2.id, jti: jti2, expiresAt: new Date(Date.now() + 3600000) },
    });

    // Buy in user 2
    await buyIn(app, token2, tableId, 1000, 1);
  });

  afterAll(async () => {
    await cleanupTestUser(app, userId);
    // Cleanup user 2 if needed, though database reset handles it
    await app.close();
  });

  it("should reject illegal SIT action sent to /action endpoint", async () => {
    // SIT is a management action, must go through /buy-in
    // Sending it to /action should be rejected by the whitelist check
    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "SIT", // Illegal for this endpoint
        seat: 1,
        amount: 1000,
      },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("INVALID_ACTION");
  });

  it("should reject illegal ADD_CHIPS action sent to /action endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "ADD_CHIPS", // Illegal for this endpoint
        amount: 1000,
      },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("INVALID_ACTION");
  });

  it("should allow valid gameplay actions (FOLD)", async () => {
    // Deal first to make FOLD valid
    await executeAction(app, token, tableId, { type: "DEAL" });

    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: "FOLD",
      },
    });

    // Should process (or at least not be 403 Forbidden, maybe 400 if not turn)
    expect(response.statusCode).not.toBe(403);
    if (response.statusCode === 400) {
      // If 400, it means it passed the whitelist but failed engine validation (e.g. not turn)
      // which confirms the whitelist check passed.
      const body = JSON.parse(response.body);
      expect(body.error).not.toBe("INVALID_ACTION");
    } else {
      expect(response.statusCode).toBe(200);
    }
  });
});
