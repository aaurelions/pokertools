/// <reference types="vitest/globals" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PokerClient } from "@pokertools/sdk";
import {
  CanonicalClient,
  apiRequest,
  bootApp,
  cleanupFixtures,
  createServicePrincipal,
  createTable,
  grantChips,
  loginWallet,
  playHand,
  promoteToOperator,
  seatPrincipal,
  startHand,
  type AcceptanceApp,
  type AnyPrincipal,
  type ServicePrincipal,
  type WalletPrincipal,
} from "./harness.js";

/**
 * Canonical gameplay acceptance.
 *
 * Every mutation is submitted through the public canonical HTTP protocol
 * (`GET /tables/:id/observation`, `POST /tables/:id/action`). Seats are claimed
 * through the public buy-in route. Direct database access is limited to a
 * declared funding fixture (chip grant) and operator bootstrap.
 */
describe("canonical gameplay acceptance", () => {
  let ctx: AcceptanceApp;
  let app: FastifyInstance;
  let operator: WalletPrincipal;
  const wallets: WalletPrincipal[] = [];
  const services: ServicePrincipal[] = [];
  const tableIds: string[] = [];

  beforeAll(async () => {
    ctx = await bootApp();
    app = ctx.app;
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(app, operator.id);
  });

  afterAll(async () => {
    if (app) {
      await cleanupFixtures(app, {
        tableIds,
        userIds: [
          operator?.id,
          ...wallets.map((wallet) => wallet.id),
          ...services.map((service) => service.id),
        ].filter((id): id is string => Boolean(id)),
      }).catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  });

  async function newWallet(): Promise<WalletPrincipal> {
    const wallet = await loginWallet(ctx.baseUrl);
    wallets.push(wallet);
    return wallet;
  }

  async function newService(
    spec: {
      scopes?: ServicePrincipal["scopes"];
      tableId?: string | null;
      seat?: number | null;
    } = {}
  ): Promise<ServicePrincipal> {
    const service = await createServicePrincipal(ctx.baseUrl, operator.token, {
      name: `svc-${services.length + 1}`,
      scopes: spec.scopes ?? ["table:observe", "table:act", "table:chat"],
      tableId: spec.tableId,
      seat: spec.seat,
    });
    services.push(service);
    return service;
  }

  async function newTable(maxPlayers: number): Promise<string> {
    const tableId = await createTable(ctx.baseUrl, operator.token, {
      name: `canonical-${maxPlayers}-${tableIds.length}`,
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers,
    });
    tableIds.push(tableId);
    return tableId;
  }

  async function seatAll(tableId: string, principals: AnyPrincipal[], stack = 1000): Promise<void> {
    await Promise.all(principals.map((principal) => grantChips(app, principal.id, stack)));
    for (const [seat, principal] of principals.entries()) {
      await seatPrincipal(ctx.baseUrl, principal, tableId, seat, stack);
    }
  }

  it("completes a two-SERVICE canonical hand with chip conservation", async () => {
    const tableId = await newTable(2);
    const [a, b] = [await newService(), await newService()];
    await seatAll(tableId, [a, b]);

    // The same published SDK contract used by browser wallets also accepts
    // real operator-issued opaque SERVICE credentials, over the live API.
    const sdk = new PokerClient({ baseUrl: ctx.baseUrl, token: a.token, retry: { count: 0 } });
    const observed = await sdk.getObservation(tableId);
    expect(observed.state.viewingPlayerId).toBe(a.id);
    const deal = observed.legalActions.find((action) => action.family === "DEAL")!;
    expect(deal).toBeDefined();
    const started = await sdk.action(tableId, {
      requestId: crypto.randomUUID(),
      turnId: observed.turnId,
      expectedVersion: observed.version,
      actionId: deal.actionId,
    });
    expect(started.receipt.version).toBe(observed.version + 1);
    expect(started.observation.state.viewingPlayerId).toBe(a.id);

    const settled = await playHand(ctx.baseUrl, tableId, [a, b]);
    expect(settled.state.winners && settled.state.winners.length).toBeGreaterThan(0);
    const total = settled.state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0);
    expect(total).toBe(2000);

    // A subsequent deal must continue the monotonic table-global counters; a new
    // hand may never fake-reset version/eventSeq.
    const redealt = await startHand(ctx.baseUrl, tableId, [a, b]);
    expect(redealt.observation.version).toBeGreaterThan(settled.version);
    expect(redealt.observation.eventSeq).toBeGreaterThan(settled.eventSeq);
    expect(redealt.observation.state.handId).not.toBe(settled.state.handId);
  });

  it("completes a mixed two-wallet / two-SERVICE canonical hand", async () => {
    const tableId = await newTable(4);
    const [walletA, walletB, serviceA, serviceB] = [
      await newWallet(),
      await newWallet(),
      await newService(),
      await newService(),
    ];
    const principals: AnyPrincipal[] = [walletA, serviceA, walletB, serviceB];
    await seatAll(tableId, principals);

    await startHand(ctx.baseUrl, tableId, principals);
    const settled = await playHand(ctx.baseUrl, tableId, principals);
    const total = settled.state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0);
    expect(total).toBe(4000);
  });

  it("seats ten principals and masks every non-viewer hand", async () => {
    const tableId = await newTable(10);
    const principals: AnyPrincipal[] = [];
    for (let index = 0; index < 10; index++) {
      principals.push(await newService());
    }
    await seatAll(tableId, principals);

    await startHand(ctx.baseUrl, tableId, principals);
    const row = await app.prisma.table.findUniqueOrThrow({ where: { id: tableId } });
    const privateSnapshot = (typeof row.state === "string" ? JSON.parse(row.state) : row.state) as {
      players: Array<{ hand: unknown[]; stack: number; totalInvestedThisHand: number }>;
    };
    expect(privateSnapshot.players).toHaveLength(10);
    for (const player of privateSnapshot.players) expect(player.hand).toHaveLength(2);
    expect(
      privateSnapshot.players.reduce(
        (sum, player) => sum + player.stack + player.totalInvestedThisHand,
        0
      )
    ).toBe(10_000);
    const viewer = principals[3]!;
    const observation = await new CanonicalClient(ctx.baseUrl, viewer).observation(tableId);
    expect(observation.state.players.filter(Boolean)).toHaveLength(10);
    expect(observation.state.players.find((player) => player?.id === viewer.id)?.hand).toHaveLength(
      2
    );
    for (const player of observation.state.players) {
      if (!player) continue;
      const visible = Array.isArray(player.hand)
        ? player.hand.filter((card) => typeof card === "string" && card.length > 0)
        : [];
      if (player.id !== viewer.id) expect(visible).toHaveLength(0);
    }
  });

  it("rejects an action from a principal that does not own the acting seat", async () => {
    const tableId = await newTable(2);
    const [a, b] = [await newWallet(), await newWallet()];
    await seatAll(tableId, [a, b]);
    const started = await startHand(ctx.baseUrl, tableId, [a, b]);

    const actorId = started.observation.state.players[started.observation.state.actionTo!]?.id;
    const owner = actorId === a.id ? a : b;
    const intruder = actorId === a.id ? b : a;
    const ownerObs = await new CanonicalClient(ctx.baseUrl, owner).observation(tableId);
    const action = ownerObs.legalActions.find((candidate) => candidate.family === "FOLD")!;

    const foreign = await new CanonicalClient(ctx.baseUrl, intruder).act(tableId, {
      requestId: crypto.randomUUID(),
      turnId: ownerObs.turnId!,
      expectedVersion: ownerObs.version,
      actionId: action.actionId,
    });
    // The authority must reject a non-owner (identity/turn/legality); any 2xx
    // would be an ownership breach. 400/403/409 are all valid rejections.
    expect(foreign.status, JSON.stringify(foreign.body)).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);

    const after = await new CanonicalClient(ctx.baseUrl, owner).observation(tableId);
    expect(after.version).toBe(ownerObs.version);
  });

  it("replays a duplicate requestId without a second version and rejects a stale expectedVersion", async () => {
    const tableId = await newTable(2);
    const [a, b] = [await newWallet(), await newWallet()];
    await seatAll(tableId, [a, b]);
    await startHand(ctx.baseUrl, tableId, [a, b]);

    const turn = await new CanonicalClient(ctx.baseUrl, a).observation(tableId);
    const actorId = turn.state.players[turn.state.actionTo!]?.id;
    const actor = actorId === a.id ? a : b;
    const client = new CanonicalClient(ctx.baseUrl, actor);
    const current = await client.observation(tableId);
    const action = current.legalActions.find((candidate) => candidate.family === "FOLD")!;
    const submission = {
      requestId: crypto.randomUUID(),
      turnId: current.turnId!,
      expectedVersion: current.version,
      actionId: action.actionId,
    };

    const first = await client.actOrThrow(tableId, submission);
    expect(first.version).toBeGreaterThan(current.version);

    const replay = await client.actOrThrow(tableId, submission);
    expect(replay.version).toBe(first.version);

    const stale = await client.act(tableId, {
      requestId: crypto.randomUUID(),
      turnId: current.turnId!,
      expectedVersion: current.version,
      actionId: action.actionId,
    });
    expect(stale.status).toBe(409);
  });

  it("returns the same authoritative version to a reconnected observer", async () => {
    const tableId = await newTable(2);
    const [a, b] = [await newWallet(), await newWallet()];
    await seatAll(tableId, [a, b]);
    await startHand(ctx.baseUrl, tableId, [a, b]);

    const client = new CanonicalClient(ctx.baseUrl, a);
    const before = await client.observation(tableId);
    const reconnected = new CanonicalClient(ctx.baseUrl, a);
    const after = await reconnected.observation(tableId);
    expect(after.version).toBe(before.version);
    expect(after.eventSeq).toBe(before.eventSeq);
    expect(after.state.deck).toEqual([]);
    expect(after.state.previousStates ?? []).toEqual([]);
  });

  it("denies a table-restricted SERVICE credential on another table", async () => {
    const tableA = await newTable(2);
    const tableB = await newTable(2);
    const restricted = await newService({ tableId: tableA, seat: null });
    // Put tableA into an active turn so a successful observe does not depend on
    // the (separately reported) hand-boundary observation response bug.
    const opponent = await newWallet();
    await seatAll(tableA, [restricted, opponent]);
    await startHand(ctx.baseUrl, tableA, [restricted, opponent]);

    const allowed = await apiRequest(ctx.baseUrl, "GET", `/tables/${tableA}/observation`, {
      token: restricted.token,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const denied = await apiRequest(ctx.baseUrl, "GET", `/tables/${tableB}/observation`, {
      token: restricted.token,
    });
    expect(denied.status).toBe(403);
  });
});
