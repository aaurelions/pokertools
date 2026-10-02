/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  CanonicalActionResultSchema,
  ReplayFrameSchema,
  SeatObservationSchema,
} from "@pokertools/types";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  cleanupTestTable,
  createTestUser,
  cleanupTestUser,
  type TestContext,
} from "../helpers/test-utils.js";

/**
 * Canonical table protocol: observation -> strict canonical action -> result.
 * Also covers append-only, bounded, HTML-inert chat and ordered replay.
 *
 * Authority is asserted through observable engine state/versions, never through
 * the opaque actionId format.
 */
describe("Canonical table protocol", () => {
  let ctx: TestContext;
  let tableId: string | undefined;

  beforeAll(async () => {
    ctx = await initTestContext(2, 100000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  afterEach(async () => {
    if (tableId) {
      await cleanupTestTable(ctx.app, tableId);
      tableId = undefined;
    }
  });

  async function freshDealtTable(): Promise<string> {
    const id = await createTable(ctx.app, ctx.users[0].token, {
      name: `Canonical ${Date.now()}`,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 100,
      maxBuyIn: 2000,
    });
    await buyIn(ctx.app, ctx.users[0].token, id, 1000, 0);
    await buyIn(ctx.app, ctx.users[1].token, id, 1000, 1);
    // Start a hand through the internal management path (canonical DEAL is a
    // boundary turn that the public action route does not accept).
    await ctx.app.gameManager.processAction(id, { type: "DEAL" }, ctx.users[0].id);
    tableId = id;
    return id;
  }

  function authGet(token: string, url: string) {
    return ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  function authPost(token: string, url: string, payload: unknown) {
    return ctx.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  }

  async function actingObservation(id: string): Promise<{ token: string; observation: any }> {
    for (const user of ctx.users) {
      const response = await authGet(user.token, `/tables/${id}/observation`);
      expect(response.statusCode).toBe(200);
      const observation = JSON.parse(response.body);
      if (Array.isArray(observation.legalActions) && observation.legalActions.length > 0) {
        return { token: user.token, observation };
      }
    }
    throw new Error("No acting seat found");
  }

  it("returns a masked observation with legal actions for the acting seat only", async () => {
    const id = await freshDealtTable();

    const acting = await actingObservation(id);
    expect(typeof acting.observation.turnId).toBe("string");
    expect(acting.observation.turnId.length).toBeGreaterThan(0);
    expect(typeof acting.observation.version).toBe("number");
    expect(acting.observation.state.deck).toEqual([]);
    expect(acting.observation.state.viewingPlayerId).toBeTruthy();

    const families = acting.observation.legalActions.map((a: any) => a.family);
    expect(families).toContain("FOLD");
    for (const action of acting.observation.legalActions) {
      expect(action.actionId).toBe(`${acting.observation.turnId}:${action.family}`);
    }

    // The observer's own hole cards are visible; every other seat is masked.
    for (const player of acting.observation.state.players) {
      if (!player) continue;
      if (player.id === acting.observation.state.viewingPlayerId) continue;
      const cards = player.hand ?? [];
      expect(cards.every((card: unknown) => card === null)).toBe(true);
    }

    // The non-acting principal receives the state but no legal actions.
    const otherUser = ctx.users.find((u) => u.token !== acting.token)!;
    const other = JSON.parse((await authGet(otherUser.token, `/tables/${id}/observation`)).body);
    expect(other.legalActions).toEqual([]);
  });

  it("rejects actor fields and legacy type bodies", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const fold = observation.legalActions.find((a: any) => a.family === "FOLD");
    const base = {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: fold.actionId,
    };

    const withActor = await authPost(token, `/tables/${id}/action`, {
      ...base,
      playerId: ctx.users[0].id,
    });
    expect(withActor.statusCode).toBe(400);

    const withPrincipal = await authPost(token, `/tables/${id}/action`, {
      ...base,
      principalId: ctx.users[0].id,
    });
    expect(withPrincipal.statusCode).toBe(400);

    const legacy = await authPost(token, `/tables/${id}/action`, { type: "CHECK" });
    expect(legacy.statusCode).toBe(400);
  });

  it("rejects stale versions, stale turns and unknown action ids", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const fold = observation.legalActions.find((a: any) => a.family === "FOLD");

    const staleVersion = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version + 1,
      actionId: fold.actionId,
    });
    expect(staleVersion.statusCode).toBe(409);
    expect(JSON.parse(staleVersion.body).error).toBe("GAME_CONFLICT");

    const staleTurn = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: "not-the-current-turn",
      expectedVersion: observation.version,
      actionId: fold.actionId,
    });
    expect(staleTurn.statusCode).toBe(409);
    expect(JSON.parse(staleTurn.body).error).toBe("STALE_TURN");

    const unknownAction = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: "not-a-legal-action",
    });
    expect(unknownAction.statusCode).toBe(400);
    expect(JSON.parse(unknownAction.body).error).toBe("INVALID_CANONICAL_ACTION");
  });

  it("applies a canonical action, returns a receipt + observation, and replays duplicates", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const call = observation.legalActions.find((a: any) => a.family === "CALL");
    const fold = observation.legalActions.find((a: any) => a.family === "FOLD");
    const chosen = call ?? fold;

    const body = {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: chosen.actionId,
      ...(call ? { amount: call.amount } : {}),
    };

    const response = await authPost(token, `/tables/${id}/action`, body);
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.receipt.requestId).toBe(body.requestId);
    expect(result.receipt.version).toBe(observation.version + 1);
    expect(result.observation.version).toBe(observation.version + 1);

    // Duplicate identical submission replays the original persisted result.
    const duplicate = await authPost(token, `/tables/${id}/action`, body);
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.body).receipt.version).toBe(result.receipt.version);

    const after = JSON.parse((await authGet(token, `/tables/${id}/observation`)).body);
    expect(after.version).toBe(result.receipt.version);
  });

  it("appends HTML-inert bounded chat without advancing the state version", async () => {
    const id = await freshDealtTable();
    const { token } = await actingObservation(id);
    const before = JSON.parse((await authGet(token, `/tables/${id}/observation`)).body);

    const injection = `<script>alert("x")</script>`;
    const chat = await authPost(token, `/tables/${id}/chat`, { body: injection });
    expect(chat.statusCode).toBe(200);
    const message = JSON.parse(chat.body);
    expect(message.body).not.toContain("<script>");
    expect(message.body).toContain("&lt;script&gt;");
    // Chat binds to the authoritative hand and never advances the state version.
    expect(typeof message.handId).toBe("string");
    expect(message.handId.length).toBeGreaterThan(0);

    const page = JSON.parse((await authGet(token, `/tables/${id}/chat?limit=50`)).body);
    expect(page.messages.some((m: any) => m.body === message.body)).toBe(true);
    for (const row of page.messages) {
      expect(typeof row.handId).toBe("string");
      expect(row.handId.length).toBeGreaterThan(0);
    }

    const oversized = await authPost(token, `/tables/${id}/chat`, { body: "a".repeat(3000) });
    expect(oversized.statusCode).toBe(200);
    expect(JSON.parse(oversized.body).body.length).toBeLessThanOrEqual(2000);

    const after = JSON.parse((await authGet(token, `/tables/${id}/observation`)).body);
    expect(after.version).toBe(before.version);

    const missing = await authPost(token, `/tables/${id}/chat`, {});
    expect(missing.statusCode).toBe(400);

    const unauthenticated = await ctx.app.inject({
      method: "POST",
      url: `/tables/${id}/chat`,
      payload: { body: "hello" },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("returns an ordered, bounded replay slice", async () => {
    const id = await freshDealtTable();
    const { token } = await actingObservation(id);

    const frame = await authGet(token, `/tables/${id}/replay?fromEventSeq=1`);
    expect(frame.statusCode).toBe(200);
    const body = JSON.parse(frame.body);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0].eventSeq).toBe(1);
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i].eventSeq).toBeGreaterThan(body.events[i - 1].eventSeq);
    }
    expect(body.chainValid).toBe(true);

    // The route returns the single shared strict ReplayFrame contract, including
    // event identity/time and hash-chain provenance with the table head bound.
    expect(ReplayFrameSchema.safeParse(body).success).toBe(true);
    expect(typeof body.events[0].eventId).toBe("string");
    expect(typeof body.events[0].occurredAt).toBe("number");
    expect(body.anchorHash).toBeNull();
    expect(body.headEventSeq).toBeGreaterThanOrEqual(body.events[body.events.length - 1].eventSeq);

    // A mid-log slice is anchored to the persisted hash of the prior record.
    const start = body.events[1].eventSeq;
    const sliced = JSON.parse(
      (await authGet(token, `/tables/${id}/replay?fromEventSeq=${start}`)).body
    );
    expect(ReplayFrameSchema.safeParse(sliced).success).toBe(true);
    expect(sliced.chainValid).toBe(true);
    expect(sliced.anchorHash).toBe(body.events[0].hash);

    expect((await authGet(token, `/tables/${id}/replay?fromEventSeq=0`)).statusCode).toBe(400);
    expect(
      (await authGet(token, `/tables/${id}/replay?fromEventSeq=2&toEventSeq=1`)).statusCode
    ).toBe(400);
  });

  it("returns a strict spectator observation for a non-seated principal", async () => {
    const id = await freshDealtTable();
    const outsider = await createTestUser(ctx.app, `spectator${Date.now()}`, 1000);
    ctx.cleanup.push(async () => {
      await cleanupTestUser(ctx.app, outsider.id);
    });

    const response = await authGet(outsider.token, `/tables/${id}/observation`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Full strict shared contract, not an ad-hoc shape.
    expect(SeatObservationSchema.safeParse(body).success).toBe(true);
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId.length).toBeGreaterThan(0);
    // A non-seated viewer is a spectator: no claimed viewer identity is leaked.
    expect(body.state.viewingPlayerId).toBeNull();
    expect(body.legalActions).toEqual([]);
    for (const player of body.state.players) {
      if (!player) continue;
      expect(player.hand).toBeNull();
    }
  });

  it("returns a boundary observation with a stable string turn id before any deal", async () => {
    const id = await createTable(ctx.app, ctx.users[0].token, {
      name: `Boundary ${Date.now()}`,
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
      minBuyIn: 100,
      maxBuyIn: 2000,
    });
    tableId = id;
    await buyIn(ctx.app, ctx.users[0].token, id, 1000, 0);
    await buyIn(ctx.app, ctx.users[1].token, id, 1000, 1);

    const response = await authGet(ctx.users[0].token, `/tables/${id}/observation`);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(SeatObservationSchema.safeParse(body).success).toBe(true);
    // No seat is to act (hand boundary), but the turn id is still a string.
    expect(body.state.actionTo).toBeNull();
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId.endsWith(":none")).toBe(true);
    expect(body.legalActions.map((a: any) => a.family)).toContain("DEAL");
  });

  it("rejects missing, unknown and non-canonical action bodies", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const fold = observation.legalActions.find((a: any) => a.family === "FOLD");

    const missingRequestId = await authPost(token, `/tables/${id}/action`, {
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: fold.actionId,
    });
    expect(missingRequestId.statusCode).toBe(400);

    const unknownKey = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: fold.actionId,
      seat: 0,
    });
    expect(unknownKey.statusCode).toBe(400);

    const nonNumericVersion = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: String(observation.version),
      actionId: fold.actionId,
    });
    expect(nonNumericVersion.statusCode).toBe(400);
  });

  it("rejects an action from a principal who does not own the acting seat", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const fold = observation.legalActions.find((a: any) => a.family === "FOLD");

    const other = ctx.users.find((user) => user.token !== token)!;
    const forged = await authPost(other.token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: fold.actionId,
    });
    // The actor is derived from auth; another seat cannot use the actor's turn.
    expect(forged.statusCode).toBe(400);
    expect(JSON.parse(forged.body).error).toBe("INVALID_CANONICAL_ACTION");
  });

  it("validates the full canonical action result against the shared schema", async () => {
    const id = await freshDealtTable();
    const { token, observation } = await actingObservation(id);
    const chosen =
      observation.legalActions.find((a: any) => a.family === "CALL") ??
      observation.legalActions.find((a: any) => a.family === "FOLD");

    const response = await authPost(token, `/tables/${id}/action`, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: chosen.actionId,
      ...(chosen.family === "CALL" && chosen.amount !== undefined ? { amount: chosen.amount } : {}),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(CanonicalActionResultSchema.safeParse(body).success).toBe(true);
    expect(body.receipt.turnId).toBe(observation.turnId);
  });
});
