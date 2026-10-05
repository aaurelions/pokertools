/// <reference types="vitest/globals" />
/**
 * Scheduled player-timeout ownership acceptance on real PostgreSQL + Redis.
 *
 * Regression for the published 2.0.1 defect where `GameManager.planTimeout`
 * re-armed the pending-turn deadline on every mutation, including
 * NEXT_BLIND_LEVEL. With blind levels shorter than the action timeout, the
 * original deadline was pushed forward forever and the pending turn never
 * expired.
 *
 * The durable timeout intent is now bound to the existing table-scoped
 * `GameState.handId` (the next-hand-owned `canonicalHandIdentity` is the same
 * identity in another context, not a second system), the immutable anchor
 * `GameEvent.eventSeq` at deadline creation and the acting player, while
 * keeping the legacy strict version fence. A timeout lease is only valid while
 * the same hand/actor still owns the turn and every intervening state mutation
 * is a benign NEXT_BLIND_LEVEL (non-mutating lifecycle projections at the
 * validated state version are harmless). Any real action, TIME_BANK renewal,
 * seat change or new hand invalidates the lease, and a long benign blind
 * history never does.
 *
 * Everything is driven through the public canonical HTTP protocol and the
 * production worker payload path; direct database access is read-only
 * inspection plus declared fixtures/teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { ActionType } from "@pokertools/types";
import {
  apiRequest,
  bootApp,
  CanonicalClient,
  cleanupFixtures,
  createTable,
  grantChips,
  loginWallet,
  playOneTurn,
  promoteToOperator,
  seatPrincipal,
  startHand,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import {
  dispatchPendingOutbox,
  durableOutboxProcessor,
  recoverGameOutbox,
} from "../../../src/services/game-outbox.js";
import {
  processPlayerTimeoutPayload,
  type PlayerTimeoutPayload,
} from "../../../src/workers/timeout-handler.js";

describe("scheduled player-timeout ownership acceptance", () => {
  let ctx: AcceptanceApp;
  let app: FastifyInstance;
  let playerA: WalletPrincipal;
  let playerB: WalletPrincipal;

  beforeAll(async () => {
    ctx = await bootApp();
    app = ctx.app;
    playerA = await loginWallet(ctx.baseUrl);
    playerB = await loginWallet(ctx.baseUrl);
  }, 60_000);

  afterAll(async () => {
    if (app) await ctx.close().catch(() => undefined);
  });

  async function newTable(
    name: string,
    seats: number,
    options: {
      mode?: "CASH" | "TOURNAMENT";
      timeBankDeductionSeconds?: number;
    } = {}
  ): Promise<string> {
    const tableId = await createTable(ctx.baseUrl, playerA.token, {
      name,
      mode: options.mode ?? "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: seats,
      ...(options.timeBankDeductionSeconds !== undefined
        ? { timeBankDeductionSeconds: options.timeBankDeductionSeconds }
        : {}),
    });
    await grantChips(app, playerA.id, 2000);
    await grantChips(app, playerB.id, 2000);
    await seatPrincipal(ctx.baseUrl, playerA, tableId, 0, 500);
    await seatPrincipal(ctx.baseUrl, playerB, tableId, 1, 500);
    return tableId;
  }

  async function originalTimeout(tableId: string) {
    return app.prisma.gameOutbox.findFirstOrThrow({
      where: { tableId, kind: "player-timeout" },
      orderBy: { createdAt: "asc" },
    });
  }

  function payloadOf(row: { payload: unknown }): PlayerTimeoutPayload {
    return row.payload as unknown as PlayerTimeoutPayload;
  }

  async function timeoutAppliedEvents(tableId: string) {
    const events = await app.prisma.gameEvent.findMany({
      where: { tableId, type: "ACTION_APPLIED" },
      orderBy: { eventSeq: "asc" },
    });
    return events.filter(
      (event) => (event.payload as { action?: string } | null)?.action === "TIMEOUT"
    );
  }

  async function fireTimeout(payload: PlayerTimeoutPayload): Promise<void> {
    await processPlayerTimeoutPayload(app.prisma, app.gameManager, payload);
  }

  /**
   * Append `count` real NEXT_BLIND_LEVEL mutations through the manager's
   * authoritative mutation path in one transaction (history fixture; every
   * mutation still seals its own event and bumps the CAS cursors). The
   * committed transport intents are dispatched afterwards, exactly as the
   * production post-commit path does, so the fixture never floods unrelated
   * recovery sweeps with PENDING rows.
   */
  async function appendBlindAdvances(tableId: string, count: number): Promise<void> {
    await app.prisma.$transaction(
      async (tx) => {
        for (let index = 0; index < count; index += 1) {
          const applied = await app.gameManager.applyManagementMutationInTx(
            tx,
            tableId,
            playerA.id,
            { type: ActionType.NEXT_BLIND_LEVEL },
            { skipIdentity: true }
          );
          expect(applied.applied).toBe(true);
        }
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
    for (;;) {
      const result = await dispatchPendingOutbox(app.prisma, app.jobQueues, app.redis, {
        tableId,
        limit: 500,
      });
      if (result.dispatched + result.failed === 0) break;
    }
  }

  it("does not re-arm the pending-turn deadline across blind advances and fires once at the original deadline on the current version", async () => {
    const tableId = await newTable("timeout-deadline", 2, { mode: "TOURNAMENT" });
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      expect(started.actionTo).not.toBeNull();
      const actor = started.players[started.actionTo!]!;
      const originalVersion = started.version;
      const original = await originalTimeout(tableId);
      const originalPayload = payloadOf(original);
      expect(originalPayload.expectedVersion).toBe(originalVersion);
      expect(originalPayload.handId).toBe(started.handId);
      expect(originalPayload.playerId).toBe(actor.id);
      expect(Number.isSafeInteger(originalPayload.anchorEventSeq)).toBe(true);

      // Two real blind-level advances while the same hand/actor is pending.
      for (let level = 0; level < 2; level += 1) {
        await app.gameManager.processAction(
          tableId,
          { type: ActionType.NEXT_BLIND_LEVEL },
          playerA.id,
          { skipIdentity: true }
        );
      }

      const advanced = await app.gameManager.getState(tableId);
      expect(advanced.version).toBe(originalVersion + 2);
      expect(advanced.handId).toBe(started.handId);
      expect(advanced.blindLevel).toBe(2);
      expect(advanced.players[advanced.actionTo!]!.id).toBe(actor.id);

      // The original deadline is the only timeout intent and it was never
      // re-armed by the blind advances.
      const after = await app.prisma.gameOutbox.findMany({
        where: { tableId, kind: "player-timeout" },
        orderBy: { createdAt: "asc" },
      });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(original.id);
      expect(after[0].availableAt.getTime()).toBe(original.availableAt.getTime());

      const processor = durableOutboxProcessor<PlayerTimeoutPayload>(
        app.prisma,
        "player-timeout",
        (payload) => processPlayerTimeoutPayload(app.prisma, app.gameManager, payload)
      );

      // A committed lease must never execute before its own deadline: the
      // durable processor refuses early even though the lease is semantically
      // valid for the current turn.
      const early = await app.prisma.gameOutbox.create({
        data: {
          tableId,
          kind: "player-timeout",
          dedupeKey: `timeout-early-fixture:${crypto.randomUUID()}`,
          payload: original.payload as never,
          status: "DISPATCHED",
          availableAt: new Date(Date.now() + 60_000),
        },
      });
      await expect(processor({ id: early.id } as never)).rejects.toThrow(
        "Outbox deadline has not elapsed"
      );
      expect((await app.gameManager.getState(tableId)).version).toBe(originalVersion + 2);
      await app.prisma.gameOutbox.delete({ where: { id: early.id } });

      // Fire exactly at the ORIGINAL deadline, on the current authoritative
      // version (the blind advances did not invalidate the lease).
      await delay(Math.max(0, original.availableAt.getTime() - Date.now() + 25));
      await processor({ id: original.id } as never);

      const fired = await app.gameManager.getState(tableId);
      expect(fired.version).toBe(originalVersion + 3);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
      expect(
        (await app.prisma.gameOutbox.findUniqueOrThrow({ where: { id: original.id } })).status
      ).toBe("COMPLETED");

      // A duplicate execution of the same committed intent applies nothing.
      await processor({ id: original.id } as never);
      expect((await app.gameManager.getState(tableId)).version).toBe(originalVersion + 3);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("keeps a valid lease owned and executes it once across more than 1024 benign blind advances", async () => {
    const tableId = await newTable("timeout-long-history", 2, { mode: "TOURNAMENT" });
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const payload = payloadOf(original);
      expect(payload.expectedVersion).toBe(started.version);

      await appendBlindAdvances(tableId, 1030);

      const longHistory = await app.gameManager.getState(tableId);
      expect(longHistory.version).toBe(started.version + 1030);
      expect(longHistory.handId).toBe(started.handId);
      expect(longHistory.players[longHistory.actionTo!]!.id).toBe(payload.playerId);

      // No cap: the lease is still owned and the original deadline is intact.
      const rows = await app.prisma.gameOutbox.findMany({
        where: { tableId, kind: "player-timeout" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].availableAt.getTime()).toBe(original.availableAt.getTime());

      await fireTimeout(payload);
      expect((await app.gameManager.getState(tableId)).version).toBe(longHistory.version + 1);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 120_000);

  it("rejects a real action embedded in a large benign blind history", async () => {
    const tableId = await newTable("timeout-long-history-action", 2);
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const stalePayload = payloadOf(original);
      const actorId = stalePayload.playerId;

      await appendBlindAdvances(tableId, 1030);

      // Return the original actor to act in the same hand after a real action;
      // the real CALL/CHECK events sit inside the long benign NBL history.
      let returned = false;
      for (let step = 0; step < 8 && !returned; step += 1) {
        const state = await app.gameManager.getState(tableId);
        if (
          state.handId === started.handId &&
          state.actionTo !== null &&
          state.players[state.actionTo]!.id === actorId &&
          state.version > started.version + 1030
        ) {
          returned = true;
          break;
        }
        if (state.actionTo === null) break;
        const turn = await playOneTurn(ctx.baseUrl, tableId, [playerA, playerB], ["CHECK", "CALL"]);
        if (!turn) break;
      }
      expect(returned).toBe(true);

      const before = await app.gameManager.getState(tableId);
      await fireTimeout(stalePayload);
      expect((await app.gameManager.getState(tableId)).version).toBe(before.version);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 120_000);

  it("rejects a stale lease once a real betting action returns the same actor to act in the same hand", async () => {
    const tableId = await newTable("timeout-same-actor", 2);
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const stalePayload = payloadOf(original);
      const originalHandId = started.handId;
      const actorId = stalePayload.playerId;

      // Check/call around the table until the original actor owns the turn
      // again in the SAME hand at a later version.
      let returned = false;
      for (let step = 0; step < 8 && !returned; step += 1) {
        const state = await app.gameManager.getState(tableId);
        if (
          state.handId === originalHandId &&
          state.actionTo !== null &&
          state.players[state.actionTo]!.id === actorId &&
          state.version > started.version
        ) {
          returned = true;
          break;
        }
        if (state.actionTo === null) break;
        const turn = await playOneTurn(ctx.baseUrl, tableId, [playerA, playerB], ["CHECK", "CALL"]);
        if (!turn) break;
      }
      expect(returned).toBe(true);

      const before = await app.gameManager.getState(tableId);
      await fireTimeout(stalePayload);
      const after = await app.gameManager.getState(tableId);
      expect(after.version).toBe(before.version);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("rejects the pre-renewal lease after TIME_BANK and keeps the extended renewal deadline", async () => {
    const tableId = await newTable("timeout-time-bank", 2, { timeBankDeductionSeconds: 1 });
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const stalePayload = payloadOf(original);
      const actorId = stalePayload.playerId;

      const actor = actorId === playerA.id ? playerA : playerB;
      const client = new CanonicalClient(ctx.baseUrl, actor);
      const turn = await client.observation(tableId);
      const timeBank = turn.legalActions.find((action) => action.family === "TIME_BANK");
      expect(timeBank).toBeDefined();
      await client.actOrThrow(tableId, {
        requestId: crypto.randomUUID(),
        turnId: turn.turnId!,
        expectedVersion: turn.version,
        actionId: timeBank!.actionId,
      });

      const renewed = await app.gameManager.getState(tableId);
      expect(renewed.handId).toBe(started.handId);
      expect(renewed.version).toBe(started.version + 1);
      expect(renewed.players[renewed.actionTo!]!.id).toBe(actorId);

      // The renewal committed a new intent with the extended deadline; the
      // pre-renewal lease must not fire.
      const rows = await app.prisma.gameOutbox.findMany({
        where: { tableId, kind: "player-timeout" },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toHaveLength(2);
      const renewal = payloadOf(rows[1]);
      expect(renewal.expectedVersion).toBe(started.version + 1);
      expect(renewal.anchorEventSeq).toBeGreaterThan(stalePayload.anchorEventSeq as number);
      expect(rows[1].availableAt.getTime()).toBeGreaterThan(rows[0].availableAt.getTime());

      const beforeStale = await app.gameManager.getState(tableId);
      await fireTimeout(stalePayload);
      expect((await app.gameManager.getState(tableId)).version).toBe(beforeStale.version);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);

      // The renewal lease still owns the turn and fires at its extended
      // deadline (existing TIME_BANK duration semantics preserved).
      await delay(Math.max(0, rows[1].availableAt.getTime() - Date.now() + 25));
      await fireTimeout(renewal);
      expect((await app.gameManager.getState(tableId)).version).toBe(beforeStale.version + 1);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("rejects a lease after a different actor takes the turn", async () => {
    const playerC = await loginWallet(ctx.baseUrl);
    const tableId = await newTable("timeout-actor-changed", 3);
    try {
      await grantChips(app, playerC.id, 2000);
      await seatPrincipal(ctx.baseUrl, playerC, tableId, 2, 500);
      await startHand(ctx.baseUrl, tableId, [playerA, playerB, playerC]);
      const original = await originalTimeout(tableId);
      const stalePayload = payloadOf(original);
      const actorId = stalePayload.playerId;

      const actor = [playerA, playerB, playerC].find((candidate) => candidate.id === actorId)!;
      const client = new CanonicalClient(ctx.baseUrl, actor);
      const turn = await client.observation(tableId);
      const fold = turn.legalActions.find((action) => action.family === "FOLD");
      expect(fold).toBeDefined();
      await client.actOrThrow(tableId, {
        requestId: crypto.randomUUID(),
        turnId: turn.turnId!,
        expectedVersion: turn.version,
        actionId: fold!.actionId,
      });

      const afterFold = await app.gameManager.getState(tableId);
      expect(afterFold.actionTo).not.toBeNull();
      expect(afterFold.players[afterFold.actionTo!]!.id).not.toBe(actorId);

      const before = afterFold.version;
      await fireTimeout(stalePayload);
      expect((await app.gameManager.getState(tableId)).version).toBe(before);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("rejects a lease after the hand changes", async () => {
    const tableId = await newTable("timeout-hand-changed", 2);
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const stalePayload = payloadOf(original);
      const actorId = stalePayload.playerId;

      // Fold the pending actor out heads-up: the hand completes.
      const actor = actorId === playerA.id ? playerA : playerB;
      const client = new CanonicalClient(ctx.baseUrl, actor);
      const turn = await client.observation(tableId);
      const fold = turn.legalActions.find((action) => action.family === "FOLD")!;
      await client.actOrThrow(tableId, {
        requestId: crypto.randomUUID(),
        turnId: turn.turnId!,
        expectedVersion: turn.version,
        actionId: fold.actionId,
      });
      const completed = await app.gameManager.getState(tableId);
      expect(completed.winners).not.toBeNull();

      // Deal the next hand: the canonical hand identity changes.
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const nextHand = await app.gameManager.getState(tableId);
      expect(nextHand.handId).not.toBe(started.handId);

      const before = nextHand.version;
      await fireTimeout(stalePayload);
      expect((await app.gameManager.getState(tableId)).version).toBe(before);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("keeps the legacy strict version guard for intents without the semantic epoch", async () => {
    const tableId = await newTable("timeout-legacy", 2, { mode: "TOURNAMENT" });
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      const actorId = payloadOf(original).playerId;

      for (let level = 0; level < 2; level += 1) {
        await app.gameManager.processAction(
          tableId,
          { type: ActionType.NEXT_BLIND_LEVEL },
          playerA.id,
          { skipIdentity: true }
        );
      }
      const current = await app.gameManager.getState(tableId);
      expect(current.version).toBe(started.version + 2);

      // A legacy payload carries only the version fence: a version advance
      // (even a benign blind level) makes it stale, exactly as before.
      const legacyStale: PlayerTimeoutPayload = {
        tableId,
        playerId: actorId,
        expectedVersion: started.version,
      };
      await fireTimeout(legacyStale);
      expect((await app.gameManager.getState(tableId)).version).toBe(current.version);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(0);

      // Strict equality, not blanket rejection: a legacy intent matching the
      // current version still applies through the legacy path.
      const legacyCurrent: PlayerTimeoutPayload = {
        tableId,
        playerId: actorId,
        expectedVersion: current.version,
      };
      await fireTimeout(legacyCurrent);
      expect((await app.gameManager.getState(tableId)).version).toBe(current.version + 1);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("recovery does not retire a valid semantic lease whose legacy version advanced", async () => {
    const tableId = await newTable("timeout-recovery", 2, { mode: "TOURNAMENT" });
    let legacyFixtureId: string | undefined;
    try {
      await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
      const started = await app.gameManager.getState(tableId);
      const original = await originalTimeout(tableId);
      for (let level = 0; level < 2; level += 1) {
        await app.gameManager.processAction(
          tableId,
          { type: ActionType.NEXT_BLIND_LEVEL },
          playerA.id,
          { skipIdentity: true }
        );
      }
      expect((await app.gameManager.getState(tableId)).version).toBe(started.version + 2);

      // Simulate Redis losing the delivered job, then run the durable sweep.
      const job = await app.jobQueues["player-timeout"].getJob(original.id);
      if (job) await job.remove();
      await recoverGameOutbox(app.prisma, app.jobQueues, app.redis);

      const row = await app.prisma.gameOutbox.findUniqueOrThrow({ where: { id: original.id } });
      expect(row.status).not.toBe("COMPLETED");
      expect(await app.jobQueues["player-timeout"].getJob(original.id)).toBeDefined();

      // Legacy stale intents keep the old retirement behavior.
      const legacyFixture = await app.prisma.gameOutbox.create({
        data: {
          tableId,
          kind: "player-timeout",
          dedupeKey: `timeout-legacy-stale-fixture:${crypto.randomUUID()}`,
          payload: {
            tableId,
            playerId: payloadOf(original).playerId,
            expectedVersion: 0,
          } as never,
          status: "DISPATCHED",
          availableAt: new Date(0),
        },
      });
      legacyFixtureId = legacyFixture.id;
      await recoverGameOutbox(app.prisma, app.jobQueues, app.redis);
      expect(
        (await app.prisma.gameOutbox.findUniqueOrThrow({ where: { id: legacyFixture.id } })).status
      ).toBe("COMPLETED");
    } finally {
      if (legacyFixtureId) {
        await app.prisma.gameOutbox.deleteMany({ where: { id: legacyFixtureId } });
      }
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);

  it("applies the original first-turn timeout after a real competition start lifecycle event and blind advances", async () => {
    const operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(app, operator.id);
    const created = await apiRequest<{
      competition?: { id: string; tableId: string };
    }>(ctx.baseUrl, "POST", "/competitions", {
      token: operator.token,
      body: {
        name: "timeout competition start",
        mode: "NONFINANCIAL",
        entrants: [
          { principalId: playerA.id, kind: "WALLET" },
          { principalId: playerB.id, kind: "WALLET" },
        ],
        smallBlind: 5,
        bigBlind: 10,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition!;
    const tableId = competition.tableId;

    try {
      const started = await apiRequest(
        ctx.baseUrl,
        "POST",
        `/competitions/${competition.id}/start`,
        {
          token: operator.token,
        }
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);

      // The real start committed the DEAL and then appended the lifecycle audit
      // projection (TOURNAMENT_STARTED) after it. The timeout lease anchored at
      // the DEAL must not be invalidated by that non-mutating projection.
      const durableCompetition = await app.prisma.competition.findUniqueOrThrow({
        where: { id: competition.id },
        select: { tournamentId: true },
      });
      const lifecycle = await app.prisma.tournamentEvent.findFirst({
        where: { tournamentId: durableCompetition.tournamentId, type: "TOURNAMENT_STARTED" },
      });
      expect(lifecycle).not.toBeNull();

      const handStarted = await app.prisma.gameEvent.findFirst({
        where: { tableId, type: "HAND_STARTED" },
      });
      expect(handStarted).not.toBeNull();

      const original = await originalTimeout(tableId);
      const payload = payloadOf(original);
      expect(payload.handId).toBeTypeOf("string");
      expect(Number.isSafeInteger(payload.anchorEventSeq)).toBe(true);

      for (let level = 0; level < 2; level += 1) {
        await app.gameManager.processAction(
          tableId,
          { type: ActionType.NEXT_BLIND_LEVEL },
          operator.id,
          { skipIdentity: true }
        );
      }
      const beforeFire = await app.gameManager.getState(tableId);
      const rows = await app.prisma.gameOutbox.findMany({
        where: { tableId, kind: "player-timeout" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].availableAt.getTime()).toBe(original.availableAt.getTime());

      await delay(Math.max(0, original.availableAt.getTime() - Date.now() + 25));
      await fireTimeout(payload);
      const fired = await app.gameManager.getState(tableId);
      expect(fired.version).toBe(beforeFire.version + 1);
      expect(await timeoutAppliedEvents(tableId)).toHaveLength(1);
    } finally {
      await cleanupFixtures(app, { tableIds: [tableId] });
    }
  }, 60_000);
});
