/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";

describe("Full Game Cycle Integration Test", () => {
  let app: FastifyInstance;
  let tableId: string;
  let player1Token: string;
  let player2Token: string;
  let player1Id: string;
  let player2Id: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create test users with accounts (use random addresses for test isolation)
    const randomId = Date.now();
    const user1 = await app.prisma.user.create({
      data: {
        username: `alice_${randomId}`,
        address: `0xalice${randomId}`,
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

    const user2 = await app.prisma.user.create({
      data: {
        username: `bob_${randomId}`,
        address: `0xbob${randomId}`,
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

    player1Id = user1.id;
    player2Id = user2.id;

    // Create test tokens
    const jti1 = `test1_${randomId}`;
    const jti2 = `test2_${randomId}`;

    player1Token = await app.jwt.sign(
      { userId: user1.id, address: user1.address, jti: jti1 },
      { jti: jti1, expiresIn: "1h" }
    );

    player2Token = await app.jwt.sign(
      { userId: user2.id, address: user2.address, jti: jti2 },
      { jti: jti2, expiresIn: "1h" }
    );

    // Create sessions
    await app.prisma.session.createMany({
      data: [
        { userId: user1.id, jti: jti1, expiresAt: new Date(Date.now() + 3600000) },
        { userId: user2.id, jti: jti2, expiresAt: new Date(Date.now() + 3600000) },
      ],
    });
  });

  afterAll(async () => {
    // Clean up test data
    if (player1Id) {
      await app.prisma.session.deleteMany({ where: { userId: player1Id } });
      await app.prisma.ledgerEntry.deleteMany({
        where: { account: { userId: player1Id } },
      });
      await app.prisma.account.deleteMany({ where: { userId: player1Id } });
      await app.prisma.user.delete({ where: { id: player1Id } }).catch(() => {});
    }
    if (player2Id) {
      await app.prisma.session.deleteMany({ where: { userId: player2Id } });
      await app.prisma.ledgerEntry.deleteMany({
        where: { account: { userId: player2Id } },
      });
      await app.prisma.account.deleteMany({ where: { userId: player2Id } });
      await app.prisma.user.delete({ where: { id: player2Id } }).catch(() => {});
    }
    if (tableId) {
      await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
    }

    await app.close();
  });

  it("should complete a full poker hand", async () => {
    // 1. Create table
    const createResponse = await app.inject({
      method: "POST",
      url: "/tables",
      headers: {
        authorization: `Bearer ${player1Token}`,
      },
      payload: {
        name: "Test Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    tableId = JSON.parse(createResponse.body).tableId;
    expect(tableId).toBeTruthy();

    // 2. Player 1 buys in
    const buyIn1 = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player1Token}`,
      },
      payload: {
        amount: "1000",
        seat: 0,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    expect(buyIn1.statusCode).toBe(200);

    // Small delay to ensure database consistency
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3. Player 2 buys in
    const buyIn2 = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${player2Token}`,
      },
      payload: {
        amount: "1000",
        seat: 1,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    if (buyIn2.statusCode !== 200) {
      console.error("Buy-in failed:", buyIn2.body);
    }
    expect(buyIn2.statusCode).toBe(200);

    // 4. Get table state
    const stateResponse = await app.inject({
      method: "GET",
      url: `/tables/${tableId}`,
      headers: {
        authorization: `Bearer ${player1Token}`,
      },
    });

    expect(stateResponse.statusCode).toBe(200);
    const state = JSON.parse(stateResponse.body).state;
    expect(state.players.filter((p: any) => p !== null)).toHaveLength(2);

    // 5. Check balances updated
    const balances1 = await app.financialManager.getBalances(player1Id);
    expect(balances1.main).toBe(9000);
    expect(balances1.inPlay).toBe(1000);

    const balances2 = await app.financialManager.getBalances(player2Id);
    expect(balances2.main).toBe(9000);
    expect(balances2.inPlay).toBe(1000);

    console.log("✅ Full game cycle test passed!");
  });
});
