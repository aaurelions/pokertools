import { describe, it, expect, afterEach } from "vitest";
import {
  initTestContext,
  runCleanup,
  createTable,
  type TestContext,
} from "../helpers/test-utils.js";

describe("Production readiness controls", () => {
  let ctx: TestContext | undefined;

  afterEach(async () => {
    if (ctx) await runCleanup(ctx.cleanup);
    ctx = undefined;
  });

  it("recovers table state from DB when Redis hot state is missing", async () => {
    ctx = await initTestContext(1);
    const tableId = await createTable(ctx.app, ctx.users[0].token, {
      name: "recovery-test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
    });

    await ctx.app.redis.del(`table:${tableId}`);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/tables/${tableId}`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).state.version).toBe(0);
    expect(await ctx.app.redis.get(`table:${tableId}`)).toBeTruthy();
  });

  it("persists high-value endpoint idempotency and rejects key reuse with a different payload", async () => {
    ctx = await initTestContext(1, 10_000);
    const tableId = await createTable(ctx.app, ctx.users[0].token, {
      name: "idempotency-test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
    });

    const key = "durable-buyin-key";
    const first = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 1_000, seat: 0, idempotencyKey: key },
    });
    const replay = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 1_000, seat: 0, idempotencyKey: key },
    });
    const conflict = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${ctx.users[0].token}` },
      payload: { amount: 2_000, seat: 0, idempotencyKey: key },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);

    const balances = await ctx.app.financialManager.getBalances(ctx.users[0].id);
    expect(balances.main).toBe(9_000);
  });

  it("exposes dependency health checks and Prometheus metrics", async () => {
    ctx = await initTestContext(1);

    const health = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const body = JSON.parse(health.body);
    expect(body.checks.db.status).toBe("ok");
    expect(body.checks.redis.status).toBe("ok");
    expect(body.checks.queue.status).toBe("ok");

    const metrics = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("pokertools_http_requests_total");
  });

  it("blocks excessive buy-in velocity before financial mutation", async () => {
    ctx = await initTestContext(1, 100_000);
    const tableId = await createTable(ctx.app, ctx.users[0].token, {
      name: "risk-test",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
    });

    let blocked = false;
    for (let i = 0; i < 14; i++) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/tables/${tableId}/buy-in`,
        headers: { authorization: `Bearer ${ctx.users[0].token}` },
        payload: { amount: 100, seat: 0, idempotencyKey: `risk-${i}` },
      });
      if (response.statusCode === 429) blocked = true;
    }

    expect(blocked).toBe(true);
  });
});
