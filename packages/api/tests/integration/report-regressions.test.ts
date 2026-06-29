/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, afterEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import {
  createTable,
  initTestContext,
  runCleanup,
  type TestContext,
} from "../helpers/test-utils.js";

describe("Report regression coverage", () => {
  let ctx: TestContext | undefined;

  afterEach(async () => {
    if (ctx) await runCleanup(ctx.cleanup);
    ctx = undefined;
  });

  it("enforces cash table minimum and maximum buy-in before debiting", async () => {
    ctx = await initTestContext(1, 10_000);
    const tableId = await createTable(ctx.app, ctx.users[0].token, {
      name: "min-max-buyin",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 500,
      maxBuyIn: 2_000,
    });

    const below = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 499, seat: 0, idempotencyKey: "buyin-below-min" },
    });
    const above = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 2_001, seat: 0, idempotencyKey: "buyin-above-max" },
    });

    expect(below.statusCode).toBe(400);
    expect(JSON.parse(below.body).error).toBe("BUY_IN_BELOW_MINIMUM");
    expect(above.statusCode).toBe(400);
    expect(JSON.parse(above.body).error).toBe("BUY_IN_ABOVE_MAXIMUM");
    expect((await ctx.app.financialManager.getBalances(ctx.users[0].id)).main).toBe(10_000);
  });

  it("enforces max buy-in for add-chips using current stack plus pending add-ons", async () => {
    ctx = await initTestContext(1, 10_000);
    const tableId = await createTable(ctx.app, ctx.users[0].token, {
      name: "max-addchips",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 500,
      maxBuyIn: 2_000,
    });

    const buyIn = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 1_500, seat: 0, idempotencyKey: "valid-buyin" },
    });
    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/add-chips`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 501, idempotencyKey: "addchips-above-max" },
    });

    expect(buyIn.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body).error).toBe("ADD_CHIPS_ABOVE_MAXIMUM");
    expect((await ctx.app.financialManager.getBalances(ctx.users[0].id)).main).toBe(8_500);
  });

  it("lists active tournament tables by default and supports mode filtering", async () => {
    ctx = await initTestContext(1);
    const cashId = await createTable(ctx.app, ctx.users[0].token, {
      name: "listed-cash",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });
    const tournamentId = await createTable(ctx.app, ctx.users[0].token, {
      name: "listed-tournament",
      mode: "TOURNAMENT",
      smallBlind: 5,
      bigBlind: 10,
    });

    const all = await ctx.app.inject({ method: "GET", url: "/tables" });
    const tournaments = await ctx.app.inject({ method: "GET", url: "/tables?mode=TOURNAMENT" });

    expect(all.statusCode).toBe(200);
    expect(JSON.parse(all.body).tables.map((table: { id: string }) => table.id)).toEqual(
      expect.arrayContaining([cashId, tournamentId])
    );
    expect(JSON.parse(tournaments.body).tables.map((table: { id: string }) => table.id)).toContain(
      tournamentId
    );
    expect(
      JSON.parse(tournaments.body).tables.map((table: { id: string }) => table.id)
    ).not.toContain(cashId);
  });

  it("rejects SIWE login for unsupported chains, expired messages, and future notBefore", async () => {
    ctx = await initTestContext(0);
    const account = privateKeyToAccount(generatePrivateKey());

    async function attempt(overrides: Partial<Parameters<typeof createSiweMessage>[0]>) {
      const nonceRes = await ctx!.app.inject({ method: "POST", url: "/auth/nonce" });
      const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };
      const message = createSiweMessage({
        address: account.address,
        chainId: 1,
        domain: "localhost",
        nonce,
        uri: "http://localhost",
        version: "1",
        ...overrides,
      });
      const signature = await account.signMessage({ message });
      return ctx!.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { message, signature },
      });
    }

    const wrongChain = await attempt({ chainId: 999_999 });
    const expired = await attempt({ expirationTime: new Date(Date.now() - 1_000) });
    const future = await attempt({ notBefore: new Date(Date.now() + 60_000) });

    expect(wrongChain.statusCode).toBe(401);
    expect(JSON.parse(wrongChain.body).error).toBe("Invalid SIWE chainId");
    expect(expired.statusCode).toBe(401);
    expect(JSON.parse(expired.body).error).toBe("SIWE message expired");
    expect(future.statusCode).toBe(401);
    expect(JSON.parse(future.body).error).toBe("SIWE message not yet valid");
  });
});
