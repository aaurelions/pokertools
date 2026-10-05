/// <reference types="vitest/globals" />
/**
 * CASE 7 — durable tournament-director retry after a post-commit failure.
 *
 * Regression for the generic lifecycle defect: `POST /tables/:id/action`
 * commits the poker action and then runs the tournament director inline
 * (`routes/tables/index.ts` ~505-528). Before the fix, a failure of that
 * post-commit pass only incremented a metric and logged a warning; nothing
 * durable scheduled a retry, and completions produced by workers (DEAL/TIMEOUT)
 * or by the start transaction never touched the route at all. A settled final
 * hand could therefore strand the busted entrant ACTIVE (and the competition
 * not settlementReady) until a human called `/reconcile` or a player acted
 * again.
 *
 * The fix commits a durable `tournament-reconcile` outbox intent in the SAME
 * transaction as every tournament HAND_COMPLETED, consumed by a real BullMQ
 * worker that runs the existing authoritative director with bounded
 * retry/backoff and restart recovery.
 *
 * This regression drives the real production paths end to end:
 * - competition provision/start through the public HTTP API (system seats +
 *   system DEAL; no manual DEAL and no engine/DB manufacturing);
 * - the final hand is completed with server-issued legal actions only
 *   (all-in RAISE + CALL);
 * - a test spy on the service Prisma `$transaction` fails the inline director
 *   transaction exactly ONCE, after the poker commit, simulating a transient
 *   PostgreSQL failure (no engine mock, no private NLHE API);
 * - the real BullMQ workers (settle/archive/next-hand/tournament-director via
 *   the canonical `timeout-worker-main.ts` fixture) consume the committed
 *   outbox; the director obligation was committed in the SAME transaction as
 *   the accepted CALL;
 * - the API process is restarted (Redis intact) before the bounded convergence
 *   window, so only a DURABLE retry can converge.
 *
 * The terminal assertions (soft, so all outcomes report together) must pass:
 * the busted entrant is eliminated automatically, the competition becomes
 * settlementReady, and canonical operator settlement finishes the tournament.
 * A sanitized PostgreSQL evidence bundle (no hole cards, deck or secrets) is
 * written before teardown: stranded-state proof, converged proof and a
 * post-settle addendum.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { CanonicalActionReceiptSchema, type SeatObservation } from "@pokertools/types";
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

/** Bounded window in which a durable automatic director retry must converge. */
const BOUNDED_RETRY_MS = 30_000;
const EVIDENCE_DIR =
  process.env.POKERTOOLS_CASE7_EVIDENCE_DIR ?? join(tmpdir(), "pokertools-case7");

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  settlementReady: boolean;
  organizerPrincipalId: string;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
}

interface PublicWireSnapshot {
  handId: string;
  handNumber: number;
  street: string;
  actionTo: number | null;
  players: Array<{ id: string; seat: number; stack: number; status: string } | null>;
  winners: Array<{ seat: number; amount: number; handRank: string | null }> | null;
}

type TransactionFn = (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;

const PRIVATE_STATE_KEYS = new Set([
  "deck",
  "hand",
  "shownCards",
  "previousStates",
  "actionHistory",
]);

/** Deterministic string form (sorted keys) for evidence comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Drop every private engine field (deck, hole cards, prior states) recursively. */
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

/** Self-check: the sanitized bundle must not contain any private key. */
function assertNoPrivateKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeys(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_STATE_KEYS.has(key)) {
        throw new Error(`evidence bundle leaked private state key "${key}" at ${path}`);
      }
      assertNoPrivateKeys(entry, `${path}.${key}`);
    }
  }
}

/** Self-check on the serialized form, including stringified JSON state columns. */
function assertNoPrivateSerialized(serialized: string): void {
  for (const key of PRIVATE_STATE_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(serialized)) {
      throw new Error(`evidence bundle leaked private state key "${key}" in serialized output`);
    }
  }
}

function waitForWorkerOutput(
  child: ChildProcess,
  marker: string,
  timeoutMs = 60_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not report ${marker}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited early with code ${code}`));
    });
  });
}

function legalFamilies(observation: SeatObservation): string {
  return observation.legalActions.map((action) => action.family).join(",");
}

describe("CASE 7 durable tournament-director retry (PostgreSQL + Redis)", () => {
  let ctx: AcceptanceApp;
  let operator: WalletPrincipal;
  let players: WalletPrincipal[] = [];
  let handWorker: ChildProcess | null = null;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];

  const stopHandWorker = async (): Promise<void> => {
    if (handWorker && handWorker.exitCode === null) {
      const exited = once(handWorker, "exit");
      handWorker.kill("SIGKILL");
      await exited;
    }
    handWorker = null;
  };

  beforeAll(async () => {
    ctx = await bootApp();
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(ctx.app, operator.id);
  }, 60_000);

  afterAll(async () => {
    await stopHandWorker().catch(() => undefined);
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
        // TournamentEntry cascades from Tournament; HandHistory/GameEvent/
        // GameOutbox cascade from Table. Competitions were deleted above
        // because the Competition -> Tournament FK is Restrict.
        await ctx.app.prisma.tournament.deleteMany({ where: { tableId: { in: tableIds } } });
        await ctx.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
      }
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });

  async function captureCase7Evidence(input: {
    phase: "post-failure-pre-worker" | "post-failure-pre-settle" | "post-settle-attempt";
    competitionId?: string;
    tournamentId?: string;
    tableId?: string;
    handId?: string;
    requestId?: string;
    loserId?: string;
    winnerId?: string;
    finalStatus?: number;
    finalReceipt?: Record<string, unknown>;
    injectedDirectorFailures?: number;
    injectedError?: string | null;
    metricAttempts?: Array<{ name: string; labels: Record<string, string> }>;
    retryWindowMs?: number;
    retryConverged?: boolean;
    retryLastEntry?: { status: string; placement: number | null } | null;
    settleAttempt?: { status: number; body: unknown } | null;
    projection?: CompetitionWire | null;
  }): Promise<string | null> {
    const app = ctx?.app;
    if (!app) return null;
    const bundle: Record<string, unknown> = {
      case: "CASE7",
      phase: input.phase,
      workstream: "phase8-durable-tournament-director-retry",
      capturedAt: new Date().toISOString(),
      ids: {
        competitionId: input.competitionId ?? null,
        tournamentId: input.tournamentId ?? null,
        tableId: input.tableId ?? null,
        handId: input.handId ?? null,
        finalRequestId: input.requestId ?? null,
        loserId: input.loserId ?? null,
        winnerId: input.winnerId ?? null,
      },
      faultInjection: {
        mechanism:
          "vi.spyOn(servicePrisma, '$transaction'): first tournament-director transaction after the poker commit rejected exactly once",
        sourceConfirmation: [
          "routes/tables/index.ts:505-528 catches the post-commit reconcile error, increments pokertools_tournament_reconcile_failures_total and logs a warning only",
          "services/game-outbox.ts:18 OutboxKind = settle-hand | archive-hand | next-hand | player-timeout | pubsub (no director kind)",
          "workers/reconciliation.ts only verifies chip/asset journal invariants (no tournament director)",
        ],
        injectedDirectorFailures: input.injectedDirectorFailures ?? null,
        injectedError: input.injectedError ?? null,
      },
      canonicalAction: {
        httpStatus: input.finalStatus ?? null,
        receipt: input.finalReceipt ?? null,
      },
      boundedAutomaticRetry: {
        windowMs: input.retryWindowMs ?? null,
        converged: input.retryConverged ?? null,
        lastEntry: input.retryLastEntry ?? null,
        note: "No new player action and no operator reconcile were submitted during this window.",
      },
      settleAttempt: input.settleAttempt ?? null,
      competitionProjection: input.projection ?? null,
      metricFailure: {
        incrementAttempts:
          input.metricAttempts?.filter(
            (attempt) => attempt.name === "pokertools_tournament_reconcile_failures_total"
          ) ?? [],
        counterRegisteredInMetrics: false,
        metricsExcerpt: [] as string[],
      },
    };

    try {
      if (input.tableId) {
        const table = await app.prisma.table.findUnique({ where: { id: input.tableId } });
        if (table) {
          // PostgreSQL `Json` columns can surface as a string through this
          // private client; parse before sanitizing so no private field is
          // ever copied verbatim.
          const rawState =
            typeof table.state === "string" ? JSON.parse(table.state) : (table.state ?? null);
          const sanitized = sanitizePrivateState(rawState);
          const normalized = stableStringify(sanitized);
          bundle.currentTable = {
            id: table.id,
            status: table.status,
            mode: table.mode,
            stateVersion: table.stateVersion,
            eventSeq: table.eventSeq,
            stateJsonSanitized: sanitized,
            stateJsonStringNormalized: normalized,
            stateJsonSanitizedSha256: crypto.createHash("sha256").update(normalized).digest("hex"),
          };
        }
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
            availableAt: true,
            createdAt: true,
          },
        });
        bundle.outbox = outbox;
        bundle.gameEvents = await app.prisma.gameEvent.findMany({
          where: { tableId: input.tableId },
          orderBy: { eventSeq: "asc" },
          select: {
            eventSeq: true,
            version: true,
            type: true,
            turnId: true,
            requestId: true,
            actionId: true,
            occurredAt: true,
          },
        });
        if (input.handId) {
          bundle.handHistory = await app.prisma.handHistory.findUnique({
            where: { id: input.handId },
            select: { id: true, tableId: true, timestamp: true },
          });
        }
      }
      if (input.tournamentId) {
        bundle.tournament = await app.prisma.tournament.findUnique({
          where: { id: input.tournamentId },
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            tableId: true,
          },
        });
        bundle.entrants = await app.prisma.tournamentEntry.findMany({
          where: { tournamentId: input.tournamentId },
          orderBy: { seat: "asc" },
          select: {
            userId: true,
            seat: true,
            status: true,
            placement: true,
            currentTableId: true,
            currentSeat: true,
          },
        });
        const events = await app.prisma.tournamentEvent.findMany({
          where: { tournamentId: input.tournamentId },
          orderBy: { eventSeq: "asc" },
          select: {
            eventSeq: true,
            type: true,
            stateFingerprint: true,
            requestRef: true,
            occurredAt: true,
          },
        });
        const reconcileEvents = events.filter((event) => event.type === "TOURNAMENT_RECONCILED");
        bundle.tournamentEvents = {
          all: events,
          reconciledCount: reconcileEvents.length,
          latestReconcileEvent: reconcileEvents.at(-1) ?? null,
        };
      }
      if (input.competitionId) {
        bundle.competition = await app.prisma.competition.findUnique({
          where: { id: input.competitionId },
          select: {
            id: true,
            status: true,
            mode: true,
            prizeStatus: true,
            startedAt: true,
            finishedAt: true,
            tournamentId: true,
          },
        });
      }
      if (input.requestId && input.tableId) {
        bundle.gameActionRequest = await app.prisma.gameActionRequest.findUnique({
          where: { tableId_requestId: { tableId: input.tableId, requestId: input.requestId } },
          select: {
            requestId: true,
            status: true,
            resultVersion: true,
            eventSeq: true,
            principalId: true,
            actionId: true,
            turnId: true,
          },
        });
      }
      if (input.handId) {
        bundle.durableDirectorIntent = await app.prisma.gameOutbox.findUnique({
          where: { dedupeKey: `tournament-reconcile:${input.handId}` },
          select: {
            id: true,
            kind: true,
            dedupeKey: true,
            status: true,
            attempts: true,
            lastError: true,
            payload: true,
            availableAt: true,
            createdAt: true,
          },
        });
      }
      const metrics = app.observabilityManager.metrics();
      (bundle.metricFailure as { metricsExcerpt: string[] }).metricsExcerpt = metrics
        .split("\n")
        .filter((line) => /reconcile|tournament|game_actions_total/.test(line));
      (bundle.metricFailure as { counterRegisteredInMetrics: boolean }).counterRegisteredInMetrics =
        metrics.includes("pokertools_tournament_reconcile_failures_total");
    } catch (error) {
      bundle.evidenceCaptureError = error instanceof Error ? error.message : String(error);
    }

    assertNoPrivateKeys(bundle);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const fileName = `case7-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}-${input.phase}-${input.competitionId ?? "unknown"}.json`;
    const filePath = join(EVIDENCE_DIR, fileName);
    const serialized = JSON.stringify(
      bundle,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
    assertNoPrivateSerialized(serialized);
    writeFileSync(filePath, serialized, "utf8");
    const latestName =
      input.phase === "post-failure-pre-settle"
        ? "latest-case7-proof.json"
        : input.phase === "post-failure-pre-worker"
          ? "latest-case7-pre-worker.json"
          : "latest-post-settle.json";
    writeFileSync(join(EVIDENCE_DIR, latestName), serialized, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[case7] sanitized PostgreSQL evidence bundle (${input.phase}): ${filePath}`);
    return filePath;
  }

  it("eliminates the busted entrant through a durable automatic retry after one transient post-commit director failure", async () => {
    players = [await loginWallet(ctx.baseUrl), await loginWallet(ctx.baseUrl)];
    const [playerA, playerB] = players;

    // 1. Ordinary two-wallet NONFINANCIAL competition through the public API.
    const created = await apiRequest<{ competition: CompetitionWire }>(
      ctx.baseUrl,
      "POST",
      "/competitions",
      {
        token: operator.token,
        body: {
          name: `case7-durable-retry-${crypto.randomBytes(3).toString("hex")}`,
          mode: "NONFINANCIAL",
          entrants: [
            { principalId: playerA.id, kind: "WALLET" },
            { principalId: playerB.id, kind: "WALLET" },
          ],
          smallBlind: 50,
          bigBlind: 100,
          startingStack: 200,
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);
    const tableId = competition.tableId;

    // Start seats both entrants and deals H1 inside the same commit (system
    // DEAL; the test never submits a DEAL).
    const started = await apiRequest(ctx.baseUrl, "POST", `/competitions/${competition.id}/start`, {
      token: operator.token,
      body: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const tournamentRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const tournamentId = tournamentRow.tournamentId;

    const clients = new Map(
      players.map((player) => [player.id, new CanonicalClient(ctx.baseUrl, player)])
    );
    const findActor = async (): Promise<{
      client: CanonicalClient;
      observation: SeatObservation;
    } | null> => {
      for (const player of players) {
        const client = clients.get(player.id)!;
        const observation = await client.observation(tableId);
        if (observation.turnId !== null && observation.legalActions.length > 0) {
          return { client, observation };
        }
      }
      return null;
    };

    // 2. Final hand, server-issued legal actions only: the first actor shoves
    // all-in, the second calls all-in. One entrant finishes with stack 0.
    const opener = await findActor();
    expect(opener, "H1 must offer a canonical legal action after the system DEAL").not.toBeNull();
    const openerState = opener!.observation.state as unknown as PublicWireSnapshot;
    const openAction =
      opener!.observation.legalActions.find((action) => action.family === "RAISE") ??
      opener!.observation.legalActions.find((action) => action.family === "BET");
    expect(
      openAction,
      `no all-in raise offered: ${legalFamilies(opener!.observation)}`
    ).toBeDefined();
    const openAmount = openAction!.maxAmount ?? openAction!.amount;
    const opened = await opener!.client.actOrThrow(tableId, {
      requestId: crypto.randomUUID(),
      turnId: opener!.observation.turnId!,
      expectedVersion: opener!.observation.version,
      actionId: openAction!.actionId,
      ...(openAmount !== undefined ? { amount: openAmount } : {}),
    });
    expect(opened.state.winners ?? null, "the shove must not complete the hand").toBeNull();
    expect(opened.state.actionTo).not.toBe(openerState.actionTo);

    // 3. Fault injection: exactly one transient service-Prisma failure in the
    // inline post-action reconcile, strictly AFTER the poker commit.
    const originalTransaction = ctx.app.prisma.$transaction.bind(
      ctx.app.prisma
    ) as unknown as TransactionFn;
    let injectedDirectorFailures = 0;
    let injectedError: string | null = null;
    const transactionSpy = vi.spyOn(ctx.app.prisma, "$transaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown
    ) => {
      const source = typeof fn === "function" ? fn.toString() : "";
      if (injectedDirectorFailures === 0 && source.includes("lockTournamentRow")) {
        injectedDirectorFailures += 1;
        injectedError = "acceptance: injected transient tournament-director reconcile failure";
        return Promise.reject(new Error(injectedError));
      }
      return originalTransaction(fn, opts);
    }) as never);

    const metricAttempts: Array<{ name: string; labels: Record<string, string> }> = [];
    const originalIncrement = ctx.app.observabilityManager.increment.bind(
      ctx.app.observabilityManager
    );
    const metricSpy = vi.spyOn(ctx.app.observabilityManager, "increment").mockImplementation(((
      name: string,
      labels: Record<string, string> = {},
      value = 1
    ) => {
      metricAttempts.push({ name, labels });
      return originalIncrement(name, labels, value);
    }) as never);

    const finalRequestId = crypto.randomUUID();
    let finalResponse: Awaited<ReturnType<CanonicalClient["act"]>> | null = null;
    let closerId: string | null = null;
    try {
      const closer = await findActor();
      expect(closer, "the second entrant must own the final turn").not.toBeNull();
      const callAction = closer!.observation.legalActions.find(
        (action) => action.family === "CALL"
      );
      expect(
        callAction,
        `no legal CALL to complete the final hand: ${legalFamilies(closer!.observation)}`
      ).toBeDefined();
      const closerState = closer!.observation.state as unknown as PublicWireSnapshot;
      closerId = closerState.players[closerState.actionTo!]!.id;
      finalResponse = await closer!.client.act(tableId, {
        requestId: finalRequestId,
        turnId: closer!.observation.turnId!,
        expectedVersion: closer!.observation.version,
        actionId: callAction!.actionId,
        ...(callAction!.amount !== undefined ? { amount: callAction!.amount } : {}),
      });
    } finally {
      transactionSpy.mockRestore();
      metricSpy.mockRestore();
    }

    // 4. The action is accepted (2xx) with a durable receipt even though the
    // post-commit director failed.
    expect(finalResponse, "the final action must have been submitted").not.toBeNull();
    expect(finalResponse!.status, JSON.stringify(finalResponse!.body).slice(0, 400)).toBe(200);
    const finalReceipt = CanonicalActionReceiptSchema.parse(
      (finalResponse!.body as { receipt: unknown }).receipt
    );
    const finalObservation = SaferSeatObservationSchema.parse(
      unwrapObservation(finalResponse!.body)
    ) as unknown as SeatObservation;
    expect(finalReceipt.requestId).toBe(finalRequestId);
    expect(finalReceipt.tableId).toBe(tableId);
    expect(finalReceipt.version).toBe(finalObservation.version);
    expect(finalReceipt.eventSeq).toBe(finalObservation.eventSeq);
    const finalState = finalObservation.state as unknown as PublicWireSnapshot;
    expect(finalState.winners ?? null).not.toBeNull();
    const positiveStacks = finalState.players.filter(
      (player): player is NonNullable<typeof player> => player !== null && player.stack > 0
    );
    expect(positiveStacks).toHaveLength(1);
    const winnerId = positiveStacks[0].id;
    const loserId = players.find((player) => player.id !== winnerId)!.id;
    const canonicalHandId = `${tableId}_${finalObservation.handId}`;

    const actionRequest = await ctx.app.prisma.gameActionRequest.findUniqueOrThrow({
      where: { tableId_requestId: { tableId, requestId: finalRequestId } },
    });
    expect(actionRequest.status).toBe("COMPLETED");
    expect(actionRequest.response).not.toBeNull();
    const handCompleted = await ctx.app.prisma.gameEvent.findMany({
      where: { tableId, type: "HAND_COMPLETED" },
      orderBy: { eventSeq: "asc" },
    });
    expect(handCompleted).toHaveLength(1);

    // Exactly one director transaction was failed, by this injection.
    expect(
      injectedDirectorFailures,
      "the post-commit director failure must fire exactly once"
    ).toBe(1);
    expect(injectedError).toContain("injected transient tournament-director reconcile failure");
    expect(
      metricAttempts.filter(
        (attempt) => attempt.name === "pokertools_tournament_reconcile_failures_total"
      )
    ).toHaveLength(1);
    const loserEntryAfterFailure = await ctx.app.prisma.tournamentEntry.findUniqueOrThrow({
      where: { tournamentId_userId: { tournamentId, userId: loserId } },
    });
    expect(loserEntryAfterFailure.status).toBe("ACTIVE");
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBe(0);

    // 5. Durable completion intents: archive exists; with only one positive
    // stack left no next-hand (and no cash settle-hand) may be intended. The
    // tournament-director obligation was written in the SAME transaction as the
    // accepted CALL, so the failure path above cannot lose it.
    const archive = await ctx.app.prisma.gameOutbox.findFirstOrThrow({
      where: { tableId, kind: "archive-hand" },
      orderBy: { createdAt: "desc" },
    });
    expect(archive.dedupeKey).toBe(`archive:${canonicalHandId}`);
    const directorIntent = await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `tournament-reconcile:${canonicalHandId}` },
    });
    expect(directorIntent.kind).toBe("tournament-reconcile");
    expect(directorIntent.payload).toMatchObject({
      tournamentId,
      tableId,
      handId: canonicalHandId,
      actorId: closerId, // the CALL was canonical: the real caller, not a forged actor
    });
    expect(
      await ctx.app.prisma.gameOutbox.findUnique({
        where: { dedupeKey: `next-hand:${canonicalHandId}` },
      })
    ).toBeNull();
    expect(await ctx.app.prisma.gameOutbox.count({ where: { tableId, kind: "next-hand" } })).toBe(
      0
    );
    expect(await ctx.app.prisma.gameOutbox.count({ where: { tableId, kind: "settle-hand" } })).toBe(
      0
    );

    // 5b. Sanitized evidence of the stranded state BEFORE the durable worker
    // runs: entrant ACTIVE, intent queued, no TOURNAMENT_RECONCILED yet.
    await captureCase7Evidence({
      phase: "post-failure-pre-worker",
      competitionId: competition.id,
      tournamentId,
      tableId,
      handId: canonicalHandId,
      requestId: finalRequestId,
      loserId,
      winnerId,
      finalStatus: finalResponse!.status,
      finalReceipt: finalReceipt as unknown as Record<string, unknown>,
      injectedDirectorFailures,
      injectedError,
      metricAttempts,
      retryWindowMs: BOUNDED_RETRY_MS,
      retryConverged: false,
      retryLastEntry: { status: loserEntryAfterFailure.status, placement: null },
      settleAttempt: null,
      projection: null,
    });

    // 6. Real worker path: the production timeout/next-hand/archive/director
    // workers (settle/archive + outbox recovery) complete the archive intent and
    // the durable director intent, which converges the tournament even though
    // the inline post-commit reconcile failed.
    handWorker = spawn(
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
    handWorker.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    await Promise.all([
      waitForWorkerOutput(handWorker, `canonical-hand-worker:completed:${archive.id}`),
      waitForWorkerOutput(
        handWorker,
        `canonical-tournament-worker:director:completed:${directorIntent.id}`
      ),
    ]);
    expect(
      await ctx.app.prisma.handHistory.findUnique({ where: { id: canonicalHandId } })
    ).not.toBeNull();
    expect(
      (
        await ctx.app.prisma.gameOutbox.findUniqueOrThrow({
          where: { id: directorIntent.id },
          select: { status: true },
        })
      ).status
    ).toBe("COMPLETED");

    // 7. Durable-retry proof boundary: restart the API (Redis intact) so no
    // in-process state survives; then wait, WITHOUT any new player action and
    // WITHOUT calling /reconcile, for the bounded automatic retry to converge.
    await ctx.close();
    ctx = await bootApp();
    const deadline = Date.now() + BOUNDED_RETRY_MS;
    let retryLastEntry: { status: string; placement: number | null } | null = null;
    let retryConverged = false;
    while (Date.now() < deadline) {
      const entry = await ctx.app.prisma.tournamentEntry.findUnique({
        where: { tournamentId_userId: { tournamentId, userId: loserId } },
        select: { status: true, placement: true },
      });
      retryLastEntry = entry ? { status: entry.status, placement: entry.placement } : null;
      if (entry?.status === "ELIMINATED") {
        retryConverged = true;
        break;
      }
      await delay(250);
    }

    const projection = await apiRequest<{ competition: CompetitionWire }>(
      ctx.baseUrl,
      "GET",
      `/competitions/${competition.id}`,
      { token: operator.token }
    );

    // 8. CASE7 proof: capture the sanitized bundle on the exact fresh affected
    // competition/table/hand BEFORE the operator settle attempt and before any
    // teardown, so it records the stranded ACTIVE entrant, the absent
    // TOURNAMENT_RECONCILED event, the outbox/entrant/table state and the
    // dropped failure metric exactly as the defect left them.
    const case7ProofPath = await captureCase7Evidence({
      phase: "post-failure-pre-settle",
      competitionId: competition.id,
      tournamentId,
      tableId,
      handId: canonicalHandId,
      requestId: finalRequestId,
      loserId,
      winnerId,
      finalStatus: finalResponse!.status,
      finalReceipt: finalReceipt as unknown as Record<string, unknown>,
      injectedDirectorFailures,
      injectedError,
      metricAttempts,
      retryWindowMs: BOUNDED_RETRY_MS,
      retryConverged,
      retryLastEntry,
      settleAttempt: null,
      projection: projection.body.competition ?? null,
    });
    expect(case7ProofPath, "CASE7 evidence bundle must be written before cleanup").not.toBeNull();

    // 9. Canonical operator settlement (NOT a reconcile) is a separate
    // capability check: it must finish the tournament once the entrant has been
    // eliminated by the retry. Capture its actual result as an addendum.
    const settleAttempt = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token, body: {} }
    );
    const tournamentAfter = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: { status: true },
    });
    const competitionAfter = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true },
    });
    await captureCase7Evidence({
      phase: "post-settle-attempt",
      competitionId: competition.id,
      tournamentId,
      tableId,
      handId: canonicalHandId,
      requestId: finalRequestId,
      loserId,
      winnerId,
      finalStatus: finalResponse!.status,
      finalReceipt: finalReceipt as unknown as Record<string, unknown>,
      injectedDirectorFailures,
      injectedError,
      metricAttempts,
      retryWindowMs: BOUNDED_RETRY_MS,
      retryConverged,
      retryLastEntry,
      settleAttempt: { status: settleAttempt.status, body: settleAttempt.body },
      projection: projection.body.competition ?? null,
    });

    // 10. Terminal expectations (must pass with the durable retry): the
    // committed director intent converges without any new player action or
    // operator reconcile; the competition becomes settlementReady and canonical
    // operator settlement finishes the tournament.
    expect
      .soft(
        {
          eliminated: retryConverged,
          status: retryLastEntry?.status ?? null,
          placement: retryLastEntry?.placement ?? null,
        },
        `durable director retry did not eliminate the busted entrant within ${BOUNDED_RETRY_MS}ms after the API restart`
      )
      .toEqual({ eliminated: true, status: "ELIMINATED", placement: 2 });

    expect
      .soft(
        projection.body.competition?.settlementReady,
        `competition settlementReady=${projection.body.competition?.settlementReady} status=${projection.body.competition?.status}`
      )
      .toBe(true);

    expect
      .soft(
        {
          settleStatus: settleAttempt.status,
          tournamentStatus: tournamentAfter.status,
          competitionStatus: competitionAfter.status,
        },
        `canonical settlement after the durable retry: ${JSON.stringify(settleAttempt.body).slice(0, 300)}`
      )
      .toEqual({ settleStatus: 200, tournamentStatus: "FINISHED", competitionStatus: "FINISHED" });
  }, 180_000);
});
