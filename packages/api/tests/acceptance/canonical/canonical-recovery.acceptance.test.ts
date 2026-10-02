/// <reference types="vitest/globals" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CanonicalClient,
  bootApp,
  cleanupFixtures,
  createTable,
  grantChips,
  loginWallet,
  seatPrincipal,
  startHand,
  acceptanceEnv,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { flushRedis, killRedis, restartRedis } from "./infra.js";
import { verifyEventChain } from "../../../src/services/game-events.js";

/**
 * Durable recovery acceptance.
 *
 * PostgreSQL is the sole game authority: flushing or killing Redis may never
 * lose a committed version, replay an action, or reorder the append-only event
 * stream. The app is also restarted (new Fastify instance) to prove recovery is
 * from durable state, not process memory.
 */
describe("canonical durable recovery acceptance", () => {
  let ctx: AcceptanceApp;
  let app: FastifyInstance;
  let playerA: WalletPrincipal;
  let playerB: WalletPrincipal;
  let tableId: string;

  beforeAll(async () => {
    ctx = await bootApp();
    app = ctx.app;
    playerA = await loginWallet(ctx.baseUrl);
    playerB = await loginWallet(ctx.baseUrl);
    tableId = await createTable(ctx.baseUrl, playerA.token, {
      name: "recovery-table",
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });
    await grantChips(app, playerA.id, 2000);
    await grantChips(app, playerB.id, 2000);
    await seatPrincipal(ctx.baseUrl, playerA, tableId, 0, 1000);
    await seatPrincipal(ctx.baseUrl, playerB, tableId, 1, 1000);
  });

  afterAll(async () => {
    if (app) {
      await cleanupFixtures(app, {
        tableIds: [tableId],
        userIds: [playerA?.id, playerB?.id].filter((id): id is string => Boolean(id)),
      }).catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  });

  async function playOneAction(): Promise<{ version: number; eventSeq: number }> {
    const principals = [playerA, playerB];
    for (const principal of principals) {
      const client = new CanonicalClient(ctx.baseUrl, principal);
      const observation = await client.observation(tableId);
      if (observation.turnId === null || observation.legalActions.length === 0) continue;
      const action =
        observation.legalActions.find((candidate) => candidate.family === "CHECK") ??
        observation.legalActions.find((candidate) => candidate.family === "FOLD") ??
        observation.legalActions[0]!;
      const next = await client.actOrThrow(tableId, {
        requestId: crypto.randomUUID(),
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: action.actionId,
        ...(action.family === "BET" || action.family === "RAISE"
          ? { amount: action.amount ?? action.minAmount }
          : {}),
      });
      return { version: next.version, eventSeq: next.eventSeq };
    }
    throw new Error("no canonical turn available to act on");
  }

  it("survives a Redis FLUSHALL with no lost version, duplicate action or reordered event", async () => {
    await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
    const committed = await playOneAction();
    const eventsBefore = await app.prisma.gameEvent.findMany({
      where: { tableId },
      orderBy: { eventSeq: "asc" },
    });
    expect(eventsBefore.length).toBeGreaterThan(0);

    // The durable outbox intent for this version committed atomically with the
    // accepted action (commit-before-pubsub). Losing Redis after the commit must
    // not lose the committed intent; it is recovered from PostgreSQL.
    const outboxBefore = await app.prisma.gameOutbox.findMany({
      where: { tableId, kind: "pubsub" },
      orderBy: { createdAt: "asc" },
    });
    expect(
      outboxBefore.some((row) => row.dedupeKey === `pubsub:${tableId}:${committed.version}`)
    ).toBe(true);

    const env = acceptanceEnv();
    await flushRedis(env.redisUrl);

    // A fresh client must observe the committed version straight from PostgreSQL.
    const recovered = await new CanonicalClient(ctx.baseUrl, playerA).observation(tableId);
    expect(recovered.version).toBe(committed.version);
    expect(recovered.eventSeq).toBeGreaterThanOrEqual(committed.eventSeq);

    // Redis is not authority: the stream must not have lost or duplicated rows.
    const eventsAfter = await app.prisma.gameEvent.findMany({
      where: { tableId },
      orderBy: { eventSeq: "asc" },
    });
    expect(eventsAfter.map((event) => event.eventSeq)).toEqual(
      eventsBefore.map((event) => event.eventSeq)
    );
    expect(verifyEventChain(tableId, eventsAfter)).toBe(true);

    // The durable outbox row survived the Redis flush unchanged: Redis delivery
    // is best-effort, the PostgreSQL intent is authoritative.
    const outboxAfter = await app.prisma.gameOutbox.findMany({
      where: { tableId, kind: "pubsub" },
      orderBy: { createdAt: "asc" },
    });
    expect(outboxAfter.map((row) => row.dedupeKey)).toEqual(
      outboxBefore.map((row) => row.dedupeKey)
    );

    // The next action advances by exactly one durable version.
    const next = await playOneAction();
    expect(next.version).toBe(committed.version + 1);
    expect(next.eventSeq).toBeGreaterThan(committed.eventSeq);
  });

  it("recovers after the Redis process is killed and restarted", async () => {
    const env = acceptanceEnv();
    await killRedis(env);
    await restartRedis(env);

    const before = await new CanonicalClient(ctx.baseUrl, playerA).observation(tableId);
    const next = await playOneAction();
    expect(next.version).toBe(before.version + 1);
  });

  it("recovers committed state from PostgreSQL after an API process restart", async () => {
    const before = await new CanonicalClient(ctx.baseUrl, playerA).observation(tableId);
    await ctx.close();

    const restarted = await bootApp();
    app = restarted.app;
    ctx = restarted;

    const recovered = await new CanonicalClient(restarted.baseUrl, playerA).observation(tableId);
    expect(recovered.version).toBe(before.version);
    expect(recovered.eventSeq).toBe(before.eventSeq);
    expect(recovered.state.handId).toBe(before.state.handId);
  });
});
