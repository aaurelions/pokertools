/// <reference types="vitest/globals" />
/**
 * Durable tournament-director completion regressions (PostgreSQL + Redis).
 *
 * Proves the API-side invariant that a `tournament-reconcile` outbox intent is
 * committed in the SAME transaction as EVERY tournament HAND_COMPLETED —
 * including completions that never pass through the HTTP action route:
 *
 * 1. a forced-blind-all-in system DEAL that completes the hand inside the
 *    competition start transaction (short starting stack relative to the fixed
 *    blinds; no REST action, no manual DEAL, no engine/DB manufacturing);
 * 2. a real BullMQ TIMEOUT worker folding the only acting player (the worker
 *    calls GameManager directly);
 * 3. the captured CASE2 shape: a sitting-out player (post-timeout) and a human
 *    fold that must complete the hand with a winner, archive it, and progress
 *    the director to the next hand or settlement-ready.
 *
 * The real worker fixture (`timeout-worker-main.ts` with
 * `POKERTOOLS_ACCEPTANCE_TOURNAMENT_WORKERS=true`) runs the production
 * timeout/next-hand/archive/director workers; the director obligation is
 * acknowledged only when it converges. The engine CASE2 completion fix lands in
 * `packages/engine` in parallel and is NOT edited here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { CanonicalActionReceiptSchema } from "@pokertools/types";
import {
  apiRequest,
  bootApp,
  CanonicalClient,
  cleanupFixtures,
  loginWallet,
  promoteToOperator,
  unwrapObservation,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { PACKAGE_DIR } from "./infra.js";
import { SaferSeatObservationSchema } from "./schemas.js";

const EVIDENCE_DIR =
  process.env.POKERTOOLS_CASE7_EVIDENCE_DIR ?? join(tmpdir(), "pokertools-case7");

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  settlementReady: boolean;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
}

const PRIVATE_STATE_KEYS = new Set([
  "deck",
  "hand",
  "shownCards",
  "previousStates",
  "actionHistory",
]);

function sanitizePrivateState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePrivateState(item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_STATE_KEYS.has(key)) continue;
      output[key] = sanitizePrivateState(entry);
    }
    return output;
  }
  return value;
}

function assertNoPrivateSerialized(serialized: string): void {
  for (const key of PRIVATE_STATE_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(serialized)) {
      throw new Error(`evidence bundle leaked private state key "${key}"`);
    }
  }
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForOutboxStatus(
  app: FastifyInstance,
  dedupeKey: string,
  status: string,
  timeoutMs = 30_000
) {
  return waitFor(
    async () => {
      const row = await app.prisma.gameOutbox.findUnique({ where: { dedupeKey } });
      return row?.status === status ? row : null;
    },
    timeoutMs,
    `outbox ${dedupeKey} -> ${status}`
  );
}

describe("durable tournament-director completions (PostgreSQL + Redis)", () => {
  let ctx: AcceptanceApp;
  let operator: WalletPrincipal;
  const players: WalletPrincipal[] = [];
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  let worker: ChildProcess | null = null;

  beforeAll(async () => {
    ctx = await bootApp();
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(ctx.app, operator.id);
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "tests/acceptance/canonical/timeout-worker-main.ts"],
      {
        cwd: PACKAGE_DIR,
        env: {
          ...process.env,
          POKERTOOLS_ACCEPTANCE_HAND_WORKERS: "true",
          POKERTOOLS_ACCEPTANCE_TOURNAMENT_WORKERS: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    worker.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    await waitFor(
      () =>
        new Promise<boolean>((resolve) => {
          const onData = (chunk: Buffer) => {
            if (chunk.toString().includes("canonical-timeout-worker:started")) {
              worker?.stdout?.off("data", onData);
              resolve(true);
            }
          };
          worker?.stdout?.on("data", onData);
          worker?.once("exit", (code) => resolve(false));
        }),
      30_000,
      "canonical worker fixture startup"
    );
  }, 90_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }
    worker = null;
    if (!ctx) return;
    try {
      await cleanupFixtures(ctx.app, {
        tableIds,
        userIds: players.map((player) => player.id),
      });
      if (competitionIds.length > 0) {
        await ctx.app.prisma.competitionEntrant.deleteMany({
          where: { competitionId: { in: competitionIds } },
        });
        await ctx.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
      }
      if (tableIds.length > 0) {
        await ctx.app.prisma.tournament.deleteMany({ where: { tableId: { in: tableIds } } });
        await ctx.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
      }
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });

  async function createStartedCompetition(
    name: string,
    startingStack: number,
    smallBlind: number,
    bigBlind: number
  ): Promise<CompetitionWire> {
    const entrants = [await loginWallet(ctx.baseUrl), await loginWallet(ctx.baseUrl)];
    players.push(...entrants);
    const created = await apiRequest<{ competition: CompetitionWire }>(
      ctx.baseUrl,
      "POST",
      "/competitions",
      {
        token: operator.token,
        body: {
          name: `${name}-${crypto.randomBytes(3).toString("hex")}`,
          mode: "NONFINANCIAL",
          entrants: entrants.map((player) => ({ principalId: player.id, kind: "WALLET" })),
          smallBlind,
          bigBlind,
          startingStack,
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);
    const started = await apiRequest(ctx.baseUrl, "POST", `/competitions/${competition.id}/start`, {
      token: operator.token,
      body: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    return competition;
  }

  async function competitionProjection(competitionId: string) {
    return apiRequest<{ competition: CompetitionWire }>(
      ctx.baseUrl,
      "GET",
      `/competitions/${competitionId}`,
      { token: operator.token }
    );
  }

  async function captureCompletionEvidence(input: {
    label: string;
    competitionId: string;
    tournamentId: string;
    tableId: string;
    handId: string;
    winnerId: string;
    loserId: string;
  }): Promise<string> {
    const app = ctx.app;
    const table = await app.prisma.table.findUnique({ where: { id: input.tableId } });
    const rawState =
      typeof table?.state === "string" ? JSON.parse(table.state) : (table?.state ?? null);
    const events = await app.prisma.gameEvent.findMany({
      where: { tableId: input.tableId },
      orderBy: { eventSeq: "asc" },
      select: { eventSeq: true, version: true, type: true, requestId: true, actionId: true },
    });
    const outbox = await app.prisma.gameOutbox.findMany({
      where: { tableId: input.tableId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        dedupeKey: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
      },
    });
    // Archive payloads carry the unmasked snapshot; only the public-id director
    // payload is safe to retain in the evidence bundle.
    const directorIntent = await app.prisma.gameOutbox.findUnique({
      where: { dedupeKey: `tournament-reconcile:${input.handId}` },
      select: { id: true, kind: true, dedupeKey: true, status: true, payload: true },
    });
    const entries = await app.prisma.tournamentEntry.findMany({
      where: { tournamentId: input.tournamentId },
      orderBy: { seat: "asc" },
      select: { userId: true, seat: true, status: true, placement: true, currentSeat: true },
    });
    const bundle = {
      case: "CASE7",
      label: input.label,
      capturedAt: new Date().toISOString(),
      ids: {
        competitionId: input.competitionId,
        tournamentId: input.tournamentId,
        tableId: input.tableId,
        handId: input.handId,
        winnerId: input.winnerId,
        loserId: input.loserId,
      },
      table: table
        ? {
            id: table.id,
            status: table.status,
            stateVersion: table.stateVersion,
            eventSeq: table.eventSeq,
            stateJsonSanitized: sanitizePrivateState(rawState),
          }
        : null,
      events,
      outbox,
      directorIntent,
      entries,
      tournamentEvents: await app.prisma.tournamentEvent.findMany({
        where: { tournamentId: input.tournamentId },
        orderBy: { eventSeq: "asc" },
        select: { eventSeq: true, type: true, stateFingerprint: true, requestRef: true },
      }),
      handHistory: await app.prisma.handHistory.findUnique({
        where: { id: input.handId },
        select: { id: true, tableId: true },
      }),
      metricsExcerpt: app.observabilityManager
        .metrics()
        .split("\n")
        .filter((line) => /tournament_reconcile|game_actions_total/.test(line)),
    };
    const serialized = JSON.stringify(
      bundle,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
    assertNoPrivateSerialized(serialized);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const path = join(EVIDENCE_DIR, `case7-${input.label}-${input.competitionId}.json`);
    writeFileSync(path, serialized, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[case7] completion evidence (${input.label}): ${path}`);
    return path;
  }

  it("converges a forced-blind-all-in DEAL completion without any REST action", async () => {
    // Legitimate published config: the starting stack is the small blind, so the
    // system DEAL (inside the start transaction) posts both forced blinds all-in
    // and the hand completes at SHOWDOWN with exactly one positive stack.
    const competition = await createStartedCompetition("director-deal", 50, 50, 100);
    const tableId = competition.tableId;
    const tournamentRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const tournamentId = tournamentRow.tournamentId;

    // A legitimate showdown tie leaves two positive stacks. Follow the real
    // AUTO_DEAL worker within the existing test budget; never manufacture a winner.
    const state = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const snapshot = await ctx.app.gameManager.getState(tableId);
        if (
          snapshot.winners?.length &&
          snapshot.actionTo == null &&
          snapshot.players.filter((player) => player !== null && player.stack > 0).length === 1
        )
          return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Automatic forced-blind completion did not produce a sole positive stack");
    })();
    expect(state.street).toBe("SHOWDOWN");
    expect(state.winners ?? null).not.toBeNull();
    const seated = state.players.filter((player) => player !== null);
    const positive = seated.filter((player) => player.stack > 0);
    expect(positive).toHaveLength(1);
    const winnerId = positive[0].id;
    const loserId =
      seated.find((player) => player.id !== winnerId)?.id ??
      (
        await ctx.app.prisma.tournamentEntry.findFirstOrThrow({
          where: {
            tournamentId: (
              await ctx.app.prisma.table.findUniqueOrThrow({
                where: { id: tableId },
                select: { tournamentId: true },
              })
            ).tournamentId!,
            userId: { not: winnerId },
          },
          select: { userId: true },
        })
      ).userId;

    const handStarted = await ctx.app.prisma.gameEvent.findFirstOrThrow({
      where: { tableId, type: "HAND_STARTED" },
      orderBy: { eventSeq: "desc" },
    });
    const handCompleted = await ctx.app.prisma.gameEvent.findFirstOrThrow({
      where: { tableId, type: "HAND_COMPLETED" },
      orderBy: { eventSeq: "desc" },
    });
    const rawHandId = (handCompleted.payload as { handId: string }).handId;
    expect((handStarted.payload as { handId: string }).handId).toBe(rawHandId);
    const canonicalHandId = `${tableId}_${rawHandId}`;

    // Durable completion intents: archive + director; no next hand is applicable
    // (one positive stack) and tournaments never write a cash settle-hand.
    await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `archive:${canonicalHandId}` },
    });
    expect(
      await ctx.app.prisma.gameOutbox.findUnique({
        where: { dedupeKey: `next-hand:${canonicalHandId}` },
      })
    ).toBeNull();
    expect(
      await ctx.app.prisma.gameOutbox.count({
        where: { tableId, kind: "next-hand", dedupeKey: `next-hand:${canonicalHandId}` },
      })
    ).toBe(0);
    expect(await ctx.app.prisma.gameOutbox.count({ where: { tableId, kind: "settle-hand" } })).toBe(
      0
    );
    const directorIntent = await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `tournament-reconcile:${canonicalHandId}` },
    });
    expect(directorIntent.kind).toBe("tournament-reconcile");
    expect(directorIntent.payload).toMatchObject({
      tournamentId,
      tableId,
      handId: canonicalHandId,
      actorId: null, // background system DEAL: never a forged caller
    });

    // The real archive and director workers converge the committed obligations.
    await waitForOutboxStatus(ctx.app, `archive:${canonicalHandId}`, "COMPLETED");
    expect(
      await ctx.app.prisma.handHistory.findUnique({ where: { id: canonicalHandId } })
    ).not.toBeNull();
    await waitForOutboxStatus(ctx.app, `tournament-reconcile:${canonicalHandId}`, "COMPLETED");
    const eliminated = await waitFor(
      async () => {
        const entry = await ctx.app.prisma.tournamentEntry.findUnique({
          where: { tournamentId_userId: { tournamentId, userId: loserId } },
          select: { status: true, placement: true },
        });
        return entry?.status === "ELIMINATED" ? entry : null;
      },
      30_000,
      "director elimination after the DEAL completion"
    );
    expect(eliminated.placement).toBe(2);
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBeGreaterThan(0);
    expect(
      await ctx.app.prisma.gameEvent.count({ where: { tableId, type: "SEAT_VACATED" } })
    ).toBeGreaterThan(0);

    const projection = await competitionProjection(competition.id);
    expect(projection.body.competition?.settlementReady).toBe(true);
    const settled = await apiRequest(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token, body: {} }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(
      (
        await ctx.app.prisma.tournament.findUniqueOrThrow({
          where: { id: tournamentId },
          select: { status: true },
        })
      ).status
    ).toBe("FINISHED");
    expect(
      (
        await ctx.app.prisma.competition.findUniqueOrThrow({
          where: { id: competition.id },
          select: { status: true },
        })
      ).status
    ).toBe("FINISHED");

    await captureCompletionEvidence({
      label: "deal-completion",
      competitionId: competition.id,
      tournamentId,
      tableId,
      handId: canonicalHandId,
      winnerId,
      loserId,
    });
  }, 120_000);

  it("writes and consumes the durable director intent for a worker TIMEOUT completion", async () => {
    const competition = await createStartedCompetition("director-timeout", 1000, 50, 100);
    const tableId = competition.tableId;
    const tournamentRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const tournamentId = tournamentRow.tournamentId;

    // No REST action is ever submitted: the real player-timeout worker folds the
    // only acting player and completes H1 through GameManager directly.
    const handCompleted = await waitFor(
      async () =>
        ctx.app.prisma.gameEvent.findFirst({
          where: { tableId, type: "HAND_COMPLETED" },
          orderBy: { eventSeq: "desc" },
        }),
      30_000,
      "timeout-worker H1 completion"
    );
    const rawHandId = (handCompleted.payload as { handId: string }).handId;
    const canonicalHandId = `${tableId}_${rawHandId}`;
    const state = await ctx.app.gameManager.getState(tableId);
    expect(state.winners ?? null).not.toBeNull();
    const seated = state.players.filter((player) => player !== null);
    expect(seated.filter((player) => player.isSittingOut)).toHaveLength(1);

    const directorIntent = await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `tournament-reconcile:${canonicalHandId}` },
    });
    expect(directorIntent.payload).toMatchObject({
      tournamentId,
      tableId,
      handId: canonicalHandId,
      actorId: null, // worker TIMEOUT: background mutation, no forged caller
    });
    await waitForOutboxStatus(ctx.app, `tournament-reconcile:${canonicalHandId}`, "COMPLETED");
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBeGreaterThan(0);
    // Two positive stacks remain: the director's progression is the next hand.
    expect(
      await ctx.app.prisma.gameOutbox.findUnique({
        where: { dedupeKey: `next-hand:${canonicalHandId}` },
      })
    ).not.toBeNull();
  }, 120_000);

  it("completes the captured post-timeout human fold and progresses the director", async () => {
    const competition = await createStartedCompetition("director-post-timeout-fold", 1000, 50, 100);
    const tableId = competition.tableId;
    const tournamentRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const tournamentId = tournamentRow.tournamentId;

    // H1 completes through the real timeout worker: the folded player sits out.
    const h1Completed = await waitFor(
      async () =>
        ctx.app.prisma.gameEvent.findFirst({
          where: { tableId, type: "HAND_COMPLETED" },
          orderBy: { eventSeq: "desc" },
        }),
      30_000,
      "timeout-worker H1 completion"
    );
    const h1RawHandId = (h1Completed.payload as { handId: string }).handId;
    const h1State = await ctx.app.gameManager.getState(tableId);
    expect(h1State.winners ?? null).not.toBeNull();
    const sittingOut = h1State.players.find((player) => player?.isSittingOut);
    const activePlayer = h1State.players.find((player) => player !== null && !player.isSittingOut);
    expect(sittingOut, "the timed-out player must be sitting out").toBeDefined();
    expect(activePlayer, "exactly one player stays active").toBeDefined();
    const human = players.find((player) => player.id === activePlayer!.id)!;
    expect(human, "the active player must be a known wallet").toBeDefined();

    // H2 is auto-dealt by the real next-hand worker; the sitting-out player is
    // auto-folded and the human owns the only decision.
    await waitFor(
      async () => ((await ctx.app.gameManager.getState(tableId)).handNumber ?? 0) >= 2,
      30_000,
      "auto-dealt H2"
    );
    const client = new CanonicalClient(ctx.baseUrl, human);
    const observation = await client.observation(tableId);
    expect(observation.turnId).not.toBeNull();
    const fold = observation.legalActions.find((action) => action.family === "FOLD");
    expect(
      fold,
      `the human must be offered FOLD: ${observation.legalActions
        .map((action) => action.family)
        .join(",")}`
    ).toBeDefined();
    const response = await client.act(tableId, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId!,
      expectedVersion: observation.version,
      actionId: fold!.actionId,
    });
    expect(response.status, JSON.stringify(response.body).slice(0, 300)).toBe(200);
    CanonicalActionReceiptSchema.parse((response.body as { receipt: unknown }).receipt);
    SaferSeatObservationSchema.parse(unwrapObservation(response.body));

    // Engine CASE2 contract (fixed in packages/engine, in parallel): an accepted
    // fold with a prior sitting-out completion must settle the hand with a
    // winner instead of stranding both players FOLDED and the pot undisbursed.
    const afterFold = await ctx.app.gameManager.getState(tableId);
    expect(
      afterFold.winners,
      "engine CASE2 fix required: the accepted fold must complete the hand with a winner"
    ).not.toBeNull();

    const h2Completed = await waitFor(
      async () => {
        const event = await ctx.app.prisma.gameEvent.findFirst({
          where: { tableId, type: "HAND_COMPLETED" },
          orderBy: { eventSeq: "desc" },
        });
        const handId = (event?.payload as { handId?: string } | null)?.handId;
        return event && handId && handId !== h1RawHandId ? event : null;
      },
      30_000,
      "HAND_COMPLETED for the folded hand"
    );
    const h2RawHandId = (h2Completed.payload as { handId: string }).handId;
    const canonicalH2 = `${tableId}_${h2RawHandId}`;
    await waitForOutboxStatus(ctx.app, `archive:${canonicalH2}`, "COMPLETED");
    await waitForOutboxStatus(ctx.app, `tournament-reconcile:${canonicalH2}`, "COMPLETED");
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBeGreaterThan(0);

    // Progression is either the next auto-dealt hand or a settlement-ready
    // competition; the tournament must never stay stuck on the folded hand.
    const nextHand = await ctx.app.prisma.gameOutbox.findUnique({
      where: { dedupeKey: `next-hand:${canonicalH2}` },
    });
    const projection = await competitionProjection(competition.id);
    expect(
      nextHand !== null || projection.body.competition?.settlementReady === true,
      "the director must progress to the next hand or settlement-ready"
    ).toBe(true);
  }, 120_000);
});
