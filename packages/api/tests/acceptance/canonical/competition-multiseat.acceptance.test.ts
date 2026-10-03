/**
 * Multi-seat generic competition acceptance on real PostgreSQL + Redis.
 *
 * Covers the 2-10 entrant competition surface beyond the existing heads-up
 * canonical scenario:
 * - a NONFINANCIAL ten-seat SERVICE competition played to completion through
 *   the SDK's server-issued legal action menus (bounded all-in/call policy);
 * - server-assigned durable seats `0..n-1` as an unbiased permutation, stable
 *   across an API process restart;
 * - concurrent `/start` requests resolving to exactly one deal and replaying
 *   the durable start naturally (no mutation idempotency key);
 * - an API restart (`bootApp.close` then a fresh boot against the same durable
 *   database, with Redis flushed) mid-hand, resuming the same active table;
 * - director reconciliation through the public route assigning eliminated
 *   placements, then SDK settlement exactly once;
 * - independent simultaneous WALLET/SERVICE competitions with no cross-table
 *   drift;
 * - stale mutation `idempotencyKey`s rejected, never ignored, and SDK
 *   `start`/`settle`/`cancel` driving the naturally idempotent lifecycle.
 *
 * Every mutation is submitted through the public HTTP/WebSocket protocol and
 * the published SDK. Direct database access is read-only inspection (durable
 * events, seats, placements) plus declared teardown; no engine state is
 * fabricated and no game outcome is written directly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import WebSocket from "ws";
import {
  CompetitionClient,
  PokerClient,
  PokerSDKError,
  PokerSocket,
  type CanonicalActionRequest,
  type Competition,
  type SeatObservation,
} from "@pokertools/sdk";
import {
  acceptanceEnv,
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { flushRedis } from "./infra.js";
import { verifyEventChain } from "../../../src/services/game-events.js";

/** Hard bounds for the bounded all-in/call policy; a breach is a real failure. */
const MAX_HANDS = 80;
const MAX_ACTIONS_PER_HAND = 400;
const WS_PUSH_TIMEOUT_MS = 10_000;

interface PlayablePrincipal {
  principalId: string;
  kind: "WALLET" | "SERVICE";
  client: PokerClient;
}

interface PlayResult {
  winnerId: string;
  observation: SeatObservation;
  handsPlayed: number;
}

async function createOrchestrator(
  baseUrl: string,
  operatorToken: string
): Promise<{ principalId: string; token: string }> {
  const response = await apiRequest<{ userId: string; token: string }>(
    baseUrl,
    "POST",
    "/auth/service-credentials",
    {
      token: operatorToken,
      body: {
        name: `multiseat-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return { principalId: response.body.userId, token: response.body.token };
}

async function provisionServicePrincipal(
  baseUrl: string,
  operatorToken: string,
  name: string,
  delegatedToPrincipalId: string
): Promise<string> {
  const response = await apiRequest<{ principalId: string }>(
    baseUrl,
    "POST",
    "/auth/service-principals",
    { token: operatorToken, body: { name, delegatedToPrincipalId } }
  );
  if (response.status !== 201) {
    throw new Error(`service principal failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.principalId;
}

async function issueAgentCredential(
  baseUrl: string,
  orchestratorToken: string,
  competitionId: string,
  principalId: string,
  label: string
): Promise<string> {
  const response = await apiRequest<{ token: string }>(
    baseUrl,
    "POST",
    `/competitions/${competitionId}/agent-credentials`,
    {
      token: orchestratorToken,
      body: {
        principalId,
        name: `multiseat-agent-${label}-${crypto.randomBytes(3).toString("hex")}`,
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`agent credential failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

function playerClient(
  baseUrl: string,
  principalId: string,
  kind: "WALLET" | "SERVICE",
  token: string
): PlayablePrincipal {
  return {
    principalId,
    kind,
    client: new PokerClient({ baseUrl, token, retry: { count: 0 } }),
  };
}

function isTurnConflict(error: unknown): boolean {
  return (
    error instanceof PokerSDKError &&
    (error.statusCode === 409 || error.code === "GAME_CONFLICT" || error.code === "STALE_TURN")
  );
}

/**
 * Submit one server-issued legal action. A conflict means another writer won
 * the turn first; the caller re-observes instead of replaying a stale request.
 */
async function submitCanonicalAction(
  client: PokerClient,
  tableId: string,
  request: CanonicalActionRequest
): Promise<SeatObservation | null> {
  try {
    const result = await client.action(tableId, request);
    return result.observation;
  } catch (error) {
    if (isTurnConflict(error)) return null;
    throw error;
  }
}

/**
 * Bounded legal all-in/call policy. Every family and amount comes from the
 * server-issued menu: raise/bet all-in when offered, otherwise call the exact
 * server amount, otherwise check, otherwise fold. Legality is never invented.
 */
function allInOrCallRequest(observation: SeatObservation): CanonicalActionRequest {
  const action =
    observation.legalActions.find((candidate) => candidate.family === "RAISE") ??
    observation.legalActions.find((candidate) => candidate.family === "BET") ??
    observation.legalActions.find((candidate) => candidate.family === "CALL") ??
    observation.legalActions.find((candidate) => candidate.family === "CHECK") ??
    observation.legalActions.find((candidate) => candidate.family === "FOLD") ??
    observation.legalActions[0];
  if (!action) {
    throw new Error(`No legal action offered for turn ${observation.turnId}`);
  }
  const takesAmount = action.family === "BET" || action.family === "RAISE";
  const amount = takesAmount
    ? action.maxAmount
    : action.family === "CALL"
      ? action.amount
      : undefined;
  if (takesAmount && amount === undefined) {
    throw new Error(`Server-issued ${action.family} has no maxAmount for all-in`);
  }
  return {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: action.actionId,
    ...(amount !== undefined ? { amount } : {}),
  };
}

/**
 * Progress a hand boundary (DEAL) or a showdown boundary (SHOW/MUCK) through
 * whichever seated principal the server offers it to. Returns the resulting
 * observation, returns immediately when another writer already advanced the
 * turn, or null when no principal can advance (caller retries from a fresh
 * observation). A completed hand with more than one live stack is dealt here:
 * the engine accepts DEAL at showdown as long as two players have chips.
 */
async function advanceBoundary(
  tableId: string,
  players: PlayablePrincipal[]
): Promise<SeatObservation | null> {
  for (const player of players) {
    const observation = await player.client.getObservation(tableId);
    if (observation.state.actionTo !== null) return observation;
    const action =
      observation.legalActions.find((candidate) => candidate.family === "DEAL") ??
      observation.legalActions.find((candidate) => candidate.family === "SHOW") ??
      observation.legalActions.find((candidate) => candidate.family === "MUCK");
    if (!action) continue;
    const next = await submitCanonicalAction(player.client, tableId, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: action.actionId,
    });
    if (next) return next;
  }
  return null;
}

function liveStackCount(observation: SeatObservation): number {
  return observation.state.players.filter((player) => player !== null && player.stack > 0).length;
}

/**
 * Play a competition to a single live stack using only SDK observations and
 * server-issued legal actions. Returns the winning principal and the final
 * settled observation; chip conservation is asserted on the wire state.
 */
async function playCompetitionToCompletion(
  tableId: string,
  players: PlayablePrincipal[],
  expectedTotalChips: number
): Promise<PlayResult> {
  if (players.length < 2) throw new Error("Competition play requires at least two principals");
  const clientByPrincipal = new Map(players.map((player) => [player.principalId, player.client]));
  const viewer = players[0]!.client;

  for (let hand = 0; hand < MAX_HANDS; hand++) {
    // Deal the next hand when the table sits at a completed boundary and more
    // than one stack is still live.
    let view = await viewer.getObservation(tableId);
    if (view.state.actionTo === null && liveStackCount(view) > 1) {
      view = (await advanceBoundary(tableId, players)) ?? view;
    }

    for (let step = 0; step < MAX_ACTIONS_PER_HAND; step++) {
      view = await viewer.getObservation(tableId);
      if (view.state.actionTo === null && (view.state.winners?.length ?? 0) > 0) break;

      if (view.state.actionTo === null) {
        const advanced = await advanceBoundary(tableId, players);
        if (advanced) view = advanced;
        continue;
      }

      const seat = view.state.actionTo;
      const actor = view.state.players[seat];
      if (!actor) throw new Error(`Seat ${seat} has no acting player`);
      const actorClient = clientByPrincipal.get(actor.id);
      if (!actorClient) {
        throw new Error(`No canonical client for acting principal ${actor.id}`);
      }
      const actorObservation = await actorClient.getObservation(tableId);
      if (actorObservation.state.actionTo === null) continue;
      const next = await submitCanonicalAction(
        actorClient,
        tableId,
        allInOrCallRequest(actorObservation)
      );
      if (next) view = next;
    }

    const settled = await viewer.getObservation(tableId);
    if (settled.state.actionTo !== null || (settled.state.winners?.length ?? 0) === 0) {
      throw new Error(
        `Hand ${hand + 1} did not complete within ${MAX_ACTIONS_PER_HAND} actions ` +
          `(actionTo=${settled.state.actionTo}, winners=${JSON.stringify(settled.state.winners)})`
      );
    }
    const live = settled.state.players.filter(
      (player): player is NonNullable<typeof player> => player !== null && player.stack > 0
    );
    if (live.length === 1) {
      // At a completed hand the pot is already awarded: only live stacks are
      // chip-conserving (per-hand invested counters are not reset for busted
      // seats until the next deal).
      const total = settled.state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0);
      if (total !== expectedTotalChips) {
        throw new Error(
          `Chip conservation violated: expected ${expectedTotalChips}, observed ${total}`
        );
      }
      return { winnerId: live[0]!.id, observation: settled, handsPlayed: hand + 1 };
    }
    if (live.length === 0) throw new Error("Competition has no live stack");
  }
  throw new Error(`Competition did not complete within ${MAX_HANDS} hands`);
}

async function reconcileCompetition(
  baseUrl: string,
  token: string,
  competitionId: string
): Promise<void> {
  const response = await apiRequest(baseUrl, "POST", `/competitions/${competitionId}/reconcile`, {
    token,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function tournamentIdFor(app: AcceptanceApp["app"], competitionId: string): Promise<string> {
  const row = await app.prisma.competition.findUniqueOrThrow({
    where: { id: competitionId },
    select: { tournamentId: true },
  });
  return row.tournamentId;
}

describe("competition multi-seat canonical acceptance (PostgreSQL + Redis, SDK)", () => {
  let ctx: AcceptanceApp;
  let operator: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    ctx = await bootApp();
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(ctx.app, operator.id);
  });

  afterAll(async () => {
    if (!ctx) return;
    try {
      await ctx.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
      if (tableIds.length > 0) {
        await ctx.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
      }
      await ctx.app.prisma.servicePrincipalDelegation.deleteMany({
        where: {
          OR: [
            { servicePrincipalId: { in: servicePrincipalIds } },
            { delegatePrincipalId: { in: servicePrincipalIds } },
          ],
        },
      });
      await ctx.app.prisma.serviceCredential.deleteMany({
        where: { userId: { in: servicePrincipalIds } },
      });
      await ctx.app.prisma.session.deleteMany({ where: { userId: { in: servicePrincipalIds } } });
      await ctx.app.prisma.competitionEntrant.deleteMany({
        where: { principalId: { in: servicePrincipalIds } },
      });
      await ctx.app.prisma.tournamentEntry.deleteMany({
        where: { userId: { in: servicePrincipalIds } },
      });
      await ctx.app.prisma.user.deleteMany({ where: { id: { in: servicePrincipalIds } } });
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });

  it("runs a ten-seat NONFINANCIAL SERVICE competition across restart and settlement", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agentIds = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        provisionServicePrincipal(
          ctx.baseUrl,
          operator.token,
          `multiseat-agent-${index}-${crypto.randomBytes(3).toString("hex")}`,
          orchestrator.principalId
        )
      )
    );
    servicePrincipalIds.push(...agentIds);

    const sdk = new CompetitionClient({ baseUrl: ctx.baseUrl, token: orchestrator.token });
    const entrants = agentIds.map((principalId) => ({ principalId, kind: "SERVICE" as const }));
    const created = await sdk.createCompetition({
      name: "Multiseat service field",
      mode: "NONFINANCIAL",
      entrants,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.replayed).toBe(false);
    const competition: Competition = created.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    // Server-assigned durable seats: an unbiased permutation of 0..9, never
    // client-supplied and never derived from roster order.
    const seatPermutation = competition.entrants.map((entrant) => entrant.seat);
    expect([...seatPermutation].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const durableEntrants = await ctx.app.prisma.competitionEntrant.findMany({
      where: { competitionId: competition.id },
      orderBy: { seat: "asc" },
      select: { principalId: true, seat: true },
    });
    expect(durableEntrants.map((entrant) => entrant.seat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(durableEntrants.map((entrant) => entrant.principalId).sort()).toEqual(
      [...agentIds].sort()
    );

    // Two further competitions over the same roster: each is a valid permutation
    // and not every assignment is identical (CSPRNG seating is not roster order).
    const extraA = await sdk.createCompetition({
      name: "Multiseat permutation A",
      mode: "NONFINANCIAL",
      entrants,
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    const extraB = await sdk.createCompetition({
      name: "Multiseat permutation B",
      mode: "NONFINANCIAL",
      entrants,
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    for (const extra of [extraA, extraB]) {
      competitionIds.push(extra.competition.id);
      tableIds.push(extra.competition.tableId);
      expect(
        [...extra.competition.entrants.map((entrant) => entrant.seat)].sort((a, b) => a - b)
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
    // Two further competitions over the same roster: each is a valid 0..9
    // permutation and the assignment is a real per-competition shuffle, not a
    // projection of the roster order.
    const assignmentSignatures = new Set(
      [competition, extraA.competition, extraB.competition].map((candidate) =>
        candidate.entrants
          .map((entrant) => `${entrant.principalId}:${entrant.seat}`)
          .sort()
          .join(",")
      )
    );
    expect(assignmentSignatures.size).toBeGreaterThan(1);

    // The naturally idempotent lifecycle rejects a stale mutation key instead
    // of silently ignoring it.
    const staleStart = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleStart.status, JSON.stringify(staleStart.body)).toBe(400);
    expect(staleStart.body.error).toBe("VALIDATION_FAILED");
    const stillRegistering = await sdk.getCompetition(competition.id);
    expect(stillRegistering.status).toBe("REGISTRATION");
    expect(stillRegistering.startedAt).toBeNull();

    // Concurrent starts: exactly one durable deal, every loser replays the
    // winner's accepted start with identical seats.
    const concurrentStarts = await Promise.all(
      Array.from({ length: 5 }, () => sdk.start(competition.id))
    );
    for (const started of concurrentStarts) {
      expect(started.success).toBe(true);
      expect(started.competitionId).toBe(competition.id);
      expect(started.tableId).toBe(competition.tableId);
      expect([...started.seats.map((seat) => seat.seat)].sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    }
    const seatSignature = JSON.stringify(
      [...concurrentStarts[0]!.seats].sort((a, b) => a.seat - b.seat)
    );
    for (const started of concurrentStarts) {
      expect(JSON.stringify([...started.seats].sort((a, b) => a.seat - b.seat))).toBe(
        seatSignature
      );
    }

    // Natural replay of the durable start marker: no second seating and no
    // second deal, identical durable response.
    const replayedStart = await sdk.start(competition.id);
    expect(replayedStart.tableId).toBe(competition.tableId);
    expect(JSON.stringify([...replayedStart.seats].sort((a, b) => a.seat - b.seat))).toBe(
      seatSignature
    );
    const running = await sdk.getCompetition(competition.id);
    expect(running.status).toBe("RUNNING");
    expect(running.startedAt).not.toBeNull();
    expect(
      await ctx.app.prisma.gameEvent.count({
        where: { tableId: competition.tableId, type: "SEAT_OCCUPIED" },
      })
    ).toBe(10);
    expect(
      await ctx.app.prisma.gameEvent.count({
        where: { tableId: competition.tableId, type: "HAND_STARTED" },
      })
    ).toBe(1);

    // One live hand is in flight, dealt by the single accepted start.
    const agentFixtures = await Promise.all(
      agentIds.map(async (principalId, index) => ({
        principalId,
        token: await issueAgentCredential(
          ctx.baseUrl,
          orchestrator.token,
          competition.id,
          principalId,
          `seat-${index}`
        ),
      }))
    );
    const makePlayers = (baseUrl: string): PlayablePrincipal[] =>
      agentFixtures.map((fixture) =>
        playerClient(baseUrl, fixture.principalId, "SERVICE", fixture.token)
      );
    let players = makePlayers(ctx.baseUrl);
    const dealt = await players[0]!.client.getObservation(competition.tableId);
    expect(dealt.state.handNumber).toBe(1);
    expect(dealt.state.actionTo).not.toBeNull();
    expect(dealt.state.winners).toBeNull();
    expect(dealt.version).toBeGreaterThan(0);

    // WebSocket boundary: the live table pushes the same authoritative
    // observation the accepted SDK action returns.
    const socket = new PokerSocket({
      url: ctx.baseUrl.replace(/^http/, "ws") + "/ws/play",
      token: agentFixtures[0]!.token,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatInterval: 30_000,
      reconnectAttempts: 0,
    });
    await socket.connect();
    try {
      const joined = await socket.join(competition.tableId);
      expect(joined.tableId).toBe(competition.tableId);
      const pushed = new Promise<SeatObservation>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for a canonical WS observation")),
          WS_PUSH_TIMEOUT_MS
        );
        socket.on("observation", (observedTableId, observation) => {
          if (observedTableId !== competition.tableId) return;
          if (observation.version <= joined.version) return;
          clearTimeout(timer);
          resolve(observation as SeatObservation);
        });
      });

      const actorId = joined.state.players[joined.state.actionTo!]!.id;
      const actor = players.find((player) => player.principalId === actorId);
      if (!actor) throw new Error(`No SDK client for acting principal ${actorId}`);
      const actorObservation = await actor.client.getObservation(competition.tableId);
      const accepted = await actor.client.action(
        competition.tableId,
        allInOrCallRequest(actorObservation)
      );
      const pushedObservation = await pushed;
      expect(pushedObservation.version).toBe(accepted.receipt.version);
      expect(pushedObservation.eventSeq).toBe(accepted.receipt.eventSeq);
      expect(pushedObservation.state.handId).toBe(accepted.receipt.handId);
    } finally {
      socket.disconnect();
    }

    // API process restart against the same durable database (Redis flushed):
    // the active table resumes exactly where the accepted action left it.
    const beforeRestart = await players[1]!.client.getObservation(competition.tableId);
    await ctx.close();
    await flushRedis(acceptanceEnv().redisUrl);
    ctx = await bootApp();

    const restartedSdk = new CompetitionClient({ baseUrl: ctx.baseUrl, token: orchestrator.token });
    const afterRestartCompetition = await restartedSdk.getCompetition(competition.id);
    expect(afterRestartCompetition.status).toBe("RUNNING");
    expect(afterRestartCompetition.tableId).toBe(competition.tableId);
    expect(afterRestartCompetition.startedAt).toBe(running.startedAt);
    expect(
      afterRestartCompetition.entrants
        .map((entrant) => `${entrant.principalId}:${entrant.seat}`)
        .sort()
    ).toEqual(
      competition.entrants.map((entrant) => `${entrant.principalId}:${entrant.seat}`).sort()
    );
    players = makePlayers(ctx.baseUrl);
    const afterRestart = await players[1]!.client.getObservation(competition.tableId);
    expect(afterRestart.version).toBe(beforeRestart.version);
    expect(afterRestart.eventSeq).toBe(beforeRestart.eventSeq);
    expect(afterRestart.state.handId).toBe(beforeRestart.state.handId);
    expect(afterRestart.state.actionTo).toBe(beforeRestart.state.actionTo);

    // Complete the actual game through SDK-issued legal action menus only.
    const result = await playCompetitionToCompletion(competition.tableId, players, 10 * 1000);
    expect(agentIds).toContain(result.winnerId);
    expect(result.handsPlayed).toBeGreaterThanOrEqual(1);

    // The append-only event chain stayed valid across the restart and the game.
    const events = await ctx.app.prisma.gameEvent.findMany({
      where: { tableId: competition.tableId },
      orderBy: { eventSeq: "asc" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(verifyEventChain(competition.tableId, events)).toBe(true);
    const tableRow = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { stateVersion: true, eventSeq: true, status: true },
    });
    expect(tableRow.stateVersion).toBe(result.observation.version);
    expect(tableRow.eventSeq).toBe(result.observation.eventSeq);

    // Director reconciliation through the public route assigns eliminated
    // placements and stands busted seats.
    await reconcileCompetition(ctx.baseUrl, orchestrator.token, competition.id);
    const tournamentId = await tournamentIdFor(ctx.app, competition.id);
    const entries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId },
      orderBy: { seat: "asc" },
    });
    expect(entries).toHaveLength(10);
    const eliminated = entries.filter((entry) => entry.status === "ELIMINATED");
    const active = entries.filter((entry) => entry.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]!.userId).toBe(result.winnerId);
    expect(active[0]!.placement).toBeNull();
    expect(eliminated).toHaveLength(9);
    expect(eliminated.map((entry) => entry.placement).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(new Set(eliminated.map((entry) => entry.userId))).toEqual(
      new Set(agentIds.filter((principalId) => principalId !== result.winnerId))
    );

    const ready = await restartedSdk.getCompetition(competition.id);
    expect(ready.status).toBe("RUNNING");
    expect(ready.settlementReady).toBe(true);

    // SDK settlement pays/positions exactly once; a replay is the same durable
    // result and never settles twice.
    const settled = await restartedSdk.settle(competition.id);
    expect(settled.success).toBe(true);
    expect(settled.winnerPrincipalId).toBe(result.winnerId);
    expect(settled.winnerKind).toBe("SERVICE");
    expect(settled.prizeStatus).toBe("NOT_APPLICABLE");
    expect(settled.prize).toBeNull();
    expect(settled.placements).toHaveLength(10);
    expect(
      settled.placements.map((placement) => placement.placement).sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      settled.placements.find((placement) => placement.principalId === result.winnerId)?.placement
    ).toBe(1);
    const replayedSettle = await restartedSdk.settle(competition.id);
    expect(replayedSettle).toEqual(settled);
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_SETTLED" },
      })
    ).toBe(1);

    const finished = await restartedSdk.getCompetition(competition.id);
    expect(finished.status).toBe("FINISHED");
    expect(finished.settlementReady).toBe(true);

    // A stale mutation key is still rejected after FINISHED (never ignored on
    // the replay path), and the durable start replay still answers.
    const staleSettle = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleSettle.status, JSON.stringify(staleSettle.body)).toBe(400);
    expect(staleSettle.body.error).toBe("VALIDATION_FAILED");
    const startAfterFinish = await restartedSdk.start(competition.id);
    expect(startAfterFinish.tableId).toBe(competition.tableId);

    // Cancel the two permutation-only competitions through the SDK: a real
    // prestart terminal transition, replayed idempotently. The restarted app
    // serves the requests (the pre-restart base URL is gone).
    const cancelledA = await restartedSdk.cancel(extraA.competition.id);
    expect(cancelledA.status).toBe("CANCELLED");
    expect(cancelledA.prizeStatus).toBe("NOT_APPLICABLE");
    const replayedCancelA = await restartedSdk.cancel(extraA.competition.id);
    expect(replayedCancelA).toEqual(cancelledA);
    const cancelledB = await restartedSdk.cancel(extraB.competition.id);
    expect(cancelledB.status).toBe("CANCELLED");
    const replayedCancelB = await restartedSdk.cancel(extraB.competition.id);
    expect(replayedCancelB).toEqual(cancelledB);
  });

  it("runs independent mixed WALLET/SERVICE competitions simultaneously", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const serviceIds = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        provisionServicePrincipal(
          ctx.baseUrl,
          operator.token,
          `simultaneous-agent-${index}-${crypto.randomBytes(3).toString("hex")}`,
          orchestrator.principalId
        )
      )
    );
    servicePrincipalIds.push(...serviceIds);
    const [walletA, walletB, walletC] = await Promise.all([
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
    ]);

    const sdk = new CompetitionClient({ baseUrl: ctx.baseUrl, token: orchestrator.token });
    const entrantsA = [
      { principalId: walletA.id, kind: "WALLET" as const },
      { principalId: walletB.id, kind: "WALLET" as const },
      { principalId: serviceIds[0]!, kind: "SERVICE" as const },
      { principalId: serviceIds[1]!, kind: "SERVICE" as const },
    ];
    const entrantsB = [
      { principalId: walletC.id, kind: "WALLET" as const },
      { principalId: serviceIds[2]!, kind: "SERVICE" as const },
      { principalId: serviceIds[3]!, kind: "SERVICE" as const },
      { principalId: serviceIds[4]!, kind: "SERVICE" as const },
    ];

    // Independent simultaneous creation.
    const [createdA, createdB] = await Promise.all([
      sdk.createCompetition({
        name: "Simultaneous mixed A",
        mode: "NONFINANCIAL",
        entrants: entrantsA,
        startingStack: 1000,
        smallBlind: 10,
        bigBlind: 20,
        idempotencyKey: crypto.randomUUID(),
      }),
      sdk.createCompetition({
        name: "Simultaneous mixed B",
        mode: "NONFINANCIAL",
        entrants: entrantsB,
        startingStack: 1000,
        smallBlind: 10,
        bigBlind: 20,
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);
    const competitionA = createdA.competition;
    const competitionB = createdB.competition;
    competitionIds.push(competitionA.id, competitionB.id);
    tableIds.push(competitionA.tableId, competitionB.tableId);
    expect(competitionA.tableId).not.toBe(competitionB.tableId);
    for (const candidate of [competitionA, competitionB]) {
      expect([...candidate.entrants.map((entrant) => entrant.seat)].sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(candidate.entrants.some((entrant) => entrant.kind === "WALLET")).toBe(true);
      expect(candidate.entrants.some((entrant) => entrant.kind === "SERVICE")).toBe(true);
    }

    const [startedA, startedB] = await Promise.all([
      sdk.start(competitionA.id),
      sdk.start(competitionB.id),
    ]);
    expect(startedA.tableId).toBe(competitionA.tableId);
    expect(startedB.tableId).toBe(competitionB.tableId);

    const credentials = new Map<string, string>();
    for (const [competition, entrants] of [
      [competitionA, entrantsA],
      [competitionB, entrantsB],
    ] as const) {
      const serviceEntrants = entrants.filter((entrant) => entrant.kind === "SERVICE");
      const issued = await Promise.all(
        serviceEntrants.map((entrant) =>
          issueAgentCredential(
            ctx.baseUrl,
            orchestrator.token,
            competition.id,
            entrant.principalId,
            "simultaneous"
          )
        )
      );
      serviceEntrants.forEach((entrant, index) =>
        credentials.set(entrant.principalId, issued[index]!)
      );
    }

    const walletTokens = new Map([
      [walletA.id, walletA.token],
      [walletB.id, walletB.token],
      [walletC.id, walletC.token],
    ]);
    const buildPlayers = (entrants: ReadonlyArray<{ principalId: string; kind: string }>) =>
      entrants.map((entrant) => {
        const token =
          entrant.kind === "WALLET"
            ? walletTokens.get(entrant.principalId)!
            : credentials.get(entrant.principalId)!;
        return playerClient(
          ctx.baseUrl,
          entrant.principalId,
          entrant.kind === "WALLET" ? "WALLET" : "SERVICE",
          token
        );
      });
    const playersA = buildPlayers(entrantsA);
    const playersB = buildPlayers(entrantsB);

    // Both games run concurrently against the same app; each table advances
    // only its own roster.
    const [resultA, resultB] = await Promise.all([
      playCompetitionToCompletion(competitionA.tableId, playersA, 4 * 1000),
      playCompetitionToCompletion(competitionB.tableId, playersB, 4 * 1000),
    ]);
    expect(entrantsA.map((entrant) => entrant.principalId)).toContain(resultA.winnerId);
    expect(entrantsB.map((entrant) => entrant.principalId)).toContain(resultB.winnerId);
    expect(resultA.winnerId).not.toBe(resultB.winnerId);
    for (const [observation, entrants] of [
      [resultA.observation, entrantsA],
      [resultB.observation, entrantsB],
    ] as const) {
      const ids = new Set(entrants.map((entrant) => entrant.principalId));
      for (const player of observation.state.players) {
        if (player) expect(ids.has(player.id)).toBe(true);
      }
    }

    // Reconcile and settle both independently.
    await Promise.all([
      reconcileCompetition(ctx.baseUrl, orchestrator.token, competitionA.id),
      reconcileCompetition(ctx.baseUrl, orchestrator.token, competitionB.id),
    ]);
    const [tournamentA, tournamentB] = await Promise.all([
      tournamentIdFor(ctx.app, competitionA.id),
      tournamentIdFor(ctx.app, competitionB.id),
    ]);
    for (const [tournamentId, result, entrants] of [
      [tournamentA, resultA, entrantsA],
      [tournamentB, resultB, entrantsB],
    ] as const) {
      const entries = await ctx.app.prisma.tournamentEntry.findMany({
        where: { tournamentId },
        orderBy: { seat: "asc" },
      });
      expect(entries).toHaveLength(4);
      expect(entries.filter((entry) => entry.status === "ELIMINATED")).toHaveLength(3);
      expect(
        entries
          .filter((entry) => entry.status === "ELIMINATED")
          .map((entry) => entry.placement)
          .sort((a, b) => (a ?? 0) - (b ?? 0))
      ).toEqual([2, 3, 4]);
      const winnerEntry = entries.find((entry) => entry.userId === result.winnerId);
      expect(winnerEntry?.status).toBe("ACTIVE");
      expect(winnerEntry?.placement).toBeNull();
      expect(new Set(entries.map((entry) => entry.userId))).toEqual(
        new Set(entrants.map((entrant) => entrant.principalId))
      );
    }

    const [settledA, settledB] = await Promise.all([
      sdk.settle(competitionA.id),
      sdk.settle(competitionB.id),
    ]);
    for (const [settled, result, entrants] of [
      [settledA, resultA, entrantsA],
      [settledB, resultB, entrantsB],
    ] as const) {
      expect(settled.winnerPrincipalId).toBe(result.winnerId);
      expect(settled.prizeStatus).toBe("NOT_APPLICABLE");
      expect(settled.placements).toHaveLength(4);
      expect(
        settled.placements.map((placement) => placement.placement).sort((a, b) => a - b)
      ).toEqual([1, 2, 3, 4]);
      const winnerEntrant = entrants.find((entrant) => entrant.principalId === result.winnerId)!;
      expect(settled.winnerKind).toBe(winnerEntrant.kind);
    }
    const [finishedA, finishedB] = await Promise.all([
      sdk.getCompetition(competitionA.id),
      sdk.getCompetition(competitionB.id),
    ]);
    expect(finishedA.status).toBe("FINISHED");
    expect(finishedB.status).toBe("FINISHED");
    expect(finishedA.tableId).not.toBe(finishedB.tableId);
  });

  it("rejects stale mutation idempotency keys and drives cancel through the SDK", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agentIds = await Promise.all(
      Array.from({ length: 3 }, (_unused, index) =>
        provisionServicePrincipal(
          ctx.baseUrl,
          operator.token,
          `lifecycle-agent-${index}-${crypto.randomBytes(3).toString("hex")}`,
          orchestrator.principalId
        )
      )
    );
    servicePrincipalIds.push(...agentIds);

    const sdk = new CompetitionClient({ baseUrl: ctx.baseUrl, token: orchestrator.token });
    const created = await sdk.createCompetition({
      name: "Lifecycle identity",
      mode: "NONFINANCIAL",
      entrants: agentIds.map((principalId) => ({ principalId, kind: "SERVICE" as const })),
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    const competition = created.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    // Every naturally idempotent mutation rejects a stale key before touching
    // durable state; none of them ignore it.
    const staleStart = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleStart.status, JSON.stringify(staleStart.body)).toBe(400);
    expect(staleStart.body.error).toBe("VALIDATION_FAILED");
    const staleOptIn = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: operator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleOptIn.status, JSON.stringify(staleOptIn.body)).toBe(400);
    expect(staleOptIn.body.error).toBe("VALIDATION_FAILED");

    // SDK lifecycle: strict empty body, durable start marker.
    const started = await sdk.start(competition.id);
    expect(started.competitionId).toBe(competition.id);
    expect(started.seats).toHaveLength(3);
    const running = await sdk.getCompetition(competition.id);
    expect(running.status).toBe("RUNNING");

    const staleCancel = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/cancel`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleCancel.status, JSON.stringify(staleCancel.body)).toBe(400);
    expect(staleCancel.body.error).toBe("VALIDATION_FAILED");
    const staleSettle = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleSettle.status, JSON.stringify(staleSettle.body)).toBe(400);
    expect(staleSettle.body.error).toBe("VALIDATION_FAILED");
    expect((await sdk.getCompetition(competition.id)).status).toBe("RUNNING");

    // Prestart cancellation is a real terminal transition and replays durably.
    const cancelMe = await sdk.createCompetition({
      name: "Lifecycle cancel",
      mode: "NONFINANCIAL",
      entrants: agentIds.map((principalId) => ({ principalId, kind: "SERVICE" as const })),
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    competitionIds.push(cancelMe.competition.id);
    tableIds.push(cancelMe.competition.tableId);
    const staleCancelBefore = await apiRequest<{ error?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${cancelMe.competition.id}/cancel`,
      { token: orchestrator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(staleCancelBefore.status, JSON.stringify(staleCancelBefore.body)).toBe(400);
    expect(staleCancelBefore.body.error).toBe("VALIDATION_FAILED");

    const cancelled = await sdk.cancel(cancelMe.competition.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.competitionId).toBe(cancelMe.competition.id);
    expect(cancelled.prizeStatus).toBe("NOT_APPLICABLE");
    expect(cancelled.entries).toHaveLength(3);
    const replayedCancel = await sdk.cancel(cancelMe.competition.id);
    expect(replayedCancel).toEqual(cancelled);
    await expect(sdk.start(cancelMe.competition.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await sdk.getCompetition(cancelMe.competition.id)).status).toBe("CANCELLED");
  });
});
