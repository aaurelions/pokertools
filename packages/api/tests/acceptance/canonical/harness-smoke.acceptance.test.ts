/// <reference types="vitest/globals" />
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { PokerSocket, type SeatObservation } from "@pokertools/sdk";
import {
  CanonicalClient,
  apiRequest,
  bootApp,
  cleanupFixtures,
  createServicePrincipal,
  createTable,
  grantChips,
  loginWallet,
  promoteToOperator,
  seatPrincipal,
  type AcceptanceApp,
  type ServicePrincipal,
  type WalletPrincipal,
} from "./harness.js";

/**
 * Harness smoke acceptance.
 *
 * Proves the acceptance harness itself is real: a loopback API on PostgreSQL +
 * Redis, SIWE wallet auth, operator-scoped SERVICE credential minting through
 * the public route, SERVICE authentication on a table read, and SERVICE scope
 * denial on non-gameplay routes.
 */
describe("canonical acceptance harness on real PostgreSQL + Redis", () => {
  let ctx: AcceptanceApp;
  let app: FastifyInstance;
  let operator: WalletPrincipal;
  let opponent: WalletPrincipal;
  let service: ServicePrincipal;
  let tableId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    app = ctx.app;
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(app, operator.id);
    service = await createServicePrincipal(ctx.baseUrl, operator.token, {
      name: "smoke-service",
      scopes: ["table:observe", "table:act"],
    });
    tableId = await createTable(ctx.baseUrl, operator.token, {
      name: "smoke-table",
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 4,
    });
    // Seat the operator wallet through the public route. SERVICE principals are
    // currently denied on /buy-in by the SERVICE scope boundary; SERVICE seating
    // is therefore an explicit interface dependency (see README), not a harness
    // gap. This smoke test only needs a table a SERVICE credential may observe.
    await grantChips(app, operator.id, 1000);
    await seatPrincipal(ctx.baseUrl, operator, tableId, 0, 1000);
    // A second seated wallet so the table offers a DEAL at the hand boundary
    // (used by the WebSocket OBSERVATION test below).
    opponent = await loginWallet(ctx.baseUrl);
    await grantChips(app, opponent.id, 1000);
    await seatPrincipal(ctx.baseUrl, opponent, tableId, 1, 1000);
  });

  afterAll(async () => {
    if (app) {
      await cleanupFixtures(app, {
        tableIds: tableId ? [tableId] : [],
        userIds: [operator?.id, opponent?.id, service?.id].filter((id): id is string =>
          Boolean(id)
        ),
      }).catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  });

  it("serves health and readiness from PostgreSQL", async () => {
    const health = await apiRequest(ctx.baseUrl, "GET", "/health");
    expect(health.status).toBe(200);
    const ready = await apiRequest(ctx.baseUrl, "GET", "/ready");
    expect([200, 503], JSON.stringify(ready.body).slice(0, 500)).toContain(ready.status);
  });

  it("mints a SERVICE principal with no wallet address and no operator authority", async () => {
    expect(service.token.startsWith("ptsvc_")).toBe(true);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: service.id },
      select: { kind: true, address: true, role: true },
    });
    expect(user.kind).toBe("SERVICE");
    expect(user.address).toBeNull();
    expect(user.role).toBe("PLAYER");
  });

  it("authenticates the SERVICE credential on its table but denies operator routes", async () => {
    const observation = await apiRequest(ctx.baseUrl, "GET", `/tables/${tableId}/observation`, {
      token: service.token,
    });
    // 200 when the observation contract is live; 5xx/404 is a real failure, not auth.
    expect(observation.status, JSON.stringify(observation.body).slice(0, 600)).toBe(200);

    const admin = await apiRequest(ctx.baseUrl, "POST", "/auth/service-credentials", {
      token: service.token,
      body: { name: "nope", scopes: ["table:observe"] },
    });
    expect(admin.status).toBe(403);

    const profile = await apiRequest(ctx.baseUrl, "GET", "/user/me", { token: service.token });
    expect(profile.status).toBe(403);
  });

  it("rejects an unauthenticated observation", async () => {
    const response = await apiRequest(ctx.baseUrl, "GET", `/tables/${tableId}/observation`);
    expect(response.status).toBe(401);
  });

  it("delivers a full canonical OBSERVATION over WebSocket after an accepted action", async () => {
    const socket = new PokerSocket({
      url: ctx.baseUrl.replace(/^http/, "ws") + "/ws/play",
      token: operator.token,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatInterval: 30_000,
      reconnectAttempts: 0,
    });
    await socket.connect();
    try {
      // `join` resolves with a strict `SeatObservation` (canonical JOIN response),
      // never a partial or version-only frame.
      const joined = await socket.join(tableId);
      expect(joined.tableId).toBe(tableId);
      expect(joined.turnId).not.toBeNull();

      const updated = new Promise<SeatObservation>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for a canonical WS OBSERVATION")),
          10_000
        );
        socket.on("observation", (observedTableId, observation) => {
          if (observedTableId !== tableId || observation.version <= joined.version) return;
          clearTimeout(timer);
          resolve(observation as SeatObservation);
        });
      });

      const client = new CanonicalClient(ctx.baseUrl, operator);
      const deal = joined.legalActions.find((action) => action.family === "DEAL");
      expect(
        deal,
        `DEAL offered: ${joined.legalActions.map((action) => action.family).join(",") || "none"}`
      ).toBeDefined();
      const accepted = await client.actOrThrow(tableId, {
        requestId: randomUUID(),
        turnId: joined.turnId,
        expectedVersion: joined.version,
        actionId: deal!.actionId,
      });

      const pushed = await updated;
      // The push is the same authoritative boundary the HTTP action returned, and
      // the counters advance monotonically (no notify-only frame, no version reset).
      expect(pushed.version).toBe(accepted.version);
      expect(pushed.eventSeq).toBe(accepted.eventSeq);
      expect(pushed.version).toBeGreaterThan(joined.version);
      expect(pushed.eventSeq).toBeGreaterThan(joined.eventSeq);
      expect(pushed.tableId).toBe(tableId);
      expect(pushed.turnId).not.toBeNull();
    } finally {
      socket.disconnect();
    }
  });
});
