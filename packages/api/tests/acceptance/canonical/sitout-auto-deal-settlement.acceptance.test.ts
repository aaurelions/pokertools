/// <reference types="vitest/globals" />
/**
 * Sit-out auto-deal settlement acceptance on real PostgreSQL + Redis.
 *
 * Regression for the NLHE h3 platform blocker: after two failed provider
 * attempts the platform applied a real TIMEOUT, marking the agent seat sitting
 * out. In a tournament the sitting-out player still posts forced blinds/antes
 * and is folded; when the only remaining live player then shoved with no
 * caller, the hand reached SHOWDOWN with `winners === null` and an
 * undistributed pot. No HAND_COMPLETED event, archive-hand or next-hand intent
 * was produced, so the browser (auto-DEAL only) stalled.
 *
 * Everything below runs through the production paths: competition
 * start/provisioning through the public HTTP API, the committed
 * `player-timeout` outbox payload through `processPlayerTimeoutPayload`, and
 * the real BullMQ next-hand worker (`createNextHandWorker`). After the initial
 * system DEAL the test never submits a client DEAL: every next hand is
 * auto-dealt from the durable outbox, the sitting-out player is blinded off to
 * zero, and the competition reconciles to settlementReady + FINISHED with the
 * authoritative winner and conserved chips.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import type { SeatObservation } from "@pokertools/types";
import {
  apiRequest,
  bootApp,
  CanonicalClient,
  cleanupFixtures,
  loginWallet,
  promoteToOperator,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { dispatchPendingOutbox } from "../../../src/services/game-outbox.js";
import { createNextHandWorker } from "../../../src/workers/next-hand-handler.js";
import {
  processPlayerTimeoutPayload,
  type PlayerTimeoutPayload,
} from "../../../src/workers/timeout-handler.js";

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  settlementReady: boolean;
  organizerPrincipalId: string;
  entrants: Array<{ principalId: string; seat: number }>;
}

describe("sit-out auto-deal settlement (PostgreSQL + Redis, production workers)", () => {
  let booted: AcceptanceApp;
  let app: FastifyInstance;
  let human: WalletPrincipal;
  let operator: WalletPrincipal;
  let orchestrator: { principalId: string; token: string };
  let agentPrincipalId: string;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];
  const workers: Worker[] = [];

  beforeAll(async () => {
    booted = await bootApp();
    app = booted.app;
    human = await loginWallet(booted.baseUrl);
    operator = await loginWallet(booted.baseUrl);
    await promoteToOperator(app, operator.id);
  }, 60_000);

  afterAll(async () => {
    for (const worker of workers) {
      await worker.close().catch(() => undefined);
    }
    await cleanupFixtures(app, { tableIds });
    await app.prisma.competitionEntrant.deleteMany({
      where: { competitionId: { in: competitionIds } },
    });
    await app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    if (tableIds.length > 0) {
      await app.prisma.handHistory.deleteMany({ where: { tableId: { in: tableIds } } });
      await app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
    }
    await app.prisma.servicePrincipalDelegation.deleteMany({
      where: {
        OR: [
          { servicePrincipalId: { in: servicePrincipalIds } },
          { delegatePrincipalId: { in: servicePrincipalIds } },
        ],
      },
    });
    await app.prisma.serviceCredential.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await app.prisma.session.deleteMany({ where: { userId: { in: servicePrincipalIds } } });
    await app.prisma.tournamentEntry.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await app.prisma.user.deleteMany({ where: { id: { in: servicePrincipalIds } } });
    if (booted) await booted.close().catch(() => undefined);
  });

  async function createOrchestrator(): Promise<{ principalId: string; token: string }> {
    const response = await apiRequest<{ userId: string; token: string }>(
      booted.baseUrl,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        body: {
          name: `sitout-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
          scopes: ["competition:orchestrate"],
        },
      }
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { principalId: response.body.userId, token: response.body.token };
  }

  async function provisionServicePrincipal(name: string, delegatedTo: string): Promise<string> {
    const response = await apiRequest<{ principalId: string }>(
      booted.baseUrl,
      "POST",
      "/auth/service-principals",
      { token: operator.token, body: { name, delegatedToPrincipalId: delegatedTo } }
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.principalId;
  }

  /** Submit one server-issued legal action and record the family actually used. */
  async function act(
    client: CanonicalClient,
    tableId: string,
    families: readonly string[],
    used: string[]
  ): Promise<SeatObservation> {
    const observation = await client.observation(tableId);
    const turnId = observation.turnId;
    if (!turnId) {
      throw new Error(`no pending turn to submit ${families.join("/")}`);
    }
    let legal;
    for (const family of families) {
      legal = observation.legalActions.find((action) => action.family === family);
      if (legal) break;
    }
    if (!legal) {
      throw new Error(
        `no legal ${families.join("/")} action: ${observation.legalActions
          .map((action) => action.family)
          .join(",")}`
      );
    }
    used.push(legal.family);
    const takesAmount = legal.family === "BET" || legal.family === "RAISE";
    const amount = legal.amount ?? legal.maxAmount ?? legal.minAmount;
    return client.actOrThrow(tableId, {
      requestId: crypto.randomUUID(),
      turnId,
      expectedVersion: observation.version,
      actionId: legal.actionId,
      ...(takesAmount && amount !== undefined ? { amount } : {}),
    });
  }

  async function waitForHand(tableId: string, handNumber: number, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = await app.gameManager.getState(tableId);
    while (Date.now() < deadline) {
      last = await app.gameManager.getState(tableId);
      if (last.handNumber >= handNumber) return last;
      await delay(200);
    }
    throw new Error(
      `hand ${handNumber} was not auto-dealt within ${timeoutMs}ms (last hand ${last.handNumber}, street ${last.street})`
    );
  }

  async function waitForOutboxStatus(dedupeKey: string, status: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await app.prisma.gameOutbox.findUnique({ where: { dedupeKey } });
      if (row?.status === status) return row;
      await delay(100);
    }
    throw new Error(`outbox ${dedupeKey} did not reach ${status}`);
  }

  function chipTotal(state: { players: Array<{ stack: number } | null>; pots: unknown[] }): number {
    return state.players.reduce((sum, player) => sum + (player ? player.stack : 0), 0);
  }

  it("blinds off the sitting-out agent through real system auto-deals and settles with the authoritative winner", async () => {
    orchestrator = await createOrchestrator();
    servicePrincipalIds.push(orchestrator.principalId);
    agentPrincipalId = await provisionServicePrincipal(
      `sitout-agent-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agentPrincipalId);

    const created = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "POST",
      "/competitions",
      {
        token: orchestrator.token,
        body: {
          name: `sitout-auto-deal-${crypto.randomBytes(3).toString("hex")}`,
          mode: "NONFINANCIAL",
          entrants: [
            { principalId: human.id, kind: "WALLET" },
            { principalId: agentPrincipalId, kind: "SERVICE" },
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

    // The competition start seats both entrants (seat assignment is shuffled by
    // design) and deals H1 inside the same commit: this is the only system DEAL
    // the test does not trigger through the outbox.
    const started = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: orchestrator.token, body: {} }
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const humanEntrant = competition.entrants.find((entrant) => entrant.principalId === human.id);
    const agentEntrant = competition.entrants.find(
      (entrant) => entrant.principalId === agentPrincipalId
    );
    expect(humanEntrant).toBeDefined();
    expect(agentEntrant).toBeDefined();
    const humanSeat = humanEntrant!.seat;
    const agentSeat = agentEntrant!.seat;

    const client = new CanonicalClient(booted.baseUrl, human);
    const usedFamilies: string[] = [];

    // H1: the agent owns the turn at some point before it can be timed out. When
    // the human is the button it shoves first; when the agent is the button the
    // committed deadline already exists and can be fired immediately. The
    // production timeout handler folds the agent and marks it sitting out.
    if (humanSeat === 0) {
      const h1 = await act(client, competition.tableId, ["RAISE"], usedFamilies);
      expect(h1.state.actionTo).toBe(agentSeat);
    }

    const timeoutRows = await app.prisma.gameOutbox.findMany({
      where: { tableId: competition.tableId, kind: "player-timeout" },
      orderBy: { createdAt: "asc" },
    });
    const agentTimeout = [...timeoutRows]
      .reverse()
      .find((row) => (row.payload as PlayerTimeoutPayload).playerId === agentPrincipalId);
    expect(agentTimeout).toBeDefined();
    await processPlayerTimeoutPayload(
      app.prisma,
      app.gameManager,
      agentTimeout!.payload as unknown as PlayerTimeoutPayload
    );

    const h1Settled = await app.gameManager.getState(competition.tableId);
    expect(h1Settled.street).toBe("SHOWDOWN");
    expect(h1Settled.winners).not.toBeNull();
    expect(h1Settled.winners!.map((winner) => winner.seat)).toEqual([humanSeat]);
    const agentAfterH1 = h1Settled.players[agentSeat]!;
    expect(agentAfterH1.isSittingOut).toBe(true);
    expect(agentAfterH1.status).toBe("FOLDED");
    if (humanSeat === 0) {
      expect(h1Settled.players[0]!.stack).toBe(300);
      expect(agentAfterH1.stack).toBe(100);
    } else {
      expect(h1Settled.players[1]!.stack).toBe(250);
      expect(agentAfterH1.stack).toBe(150);
    }
    expect(chipTotal(h1Settled)).toBe(400);

    // Durable completion intents exist for the settled hand, and the hand that
    // still has two funded players scheduled an auto-deal.
    await app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `archive:${competition.tableId}_${h1Settled.handId}` },
    });
    const h1NextKey = `next-hand:${competition.tableId}_${h1Settled.handId}`;
    const h1Next = await app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: h1NextKey },
    });
    expect(h1Next.availableAt.getTime()).toBeGreaterThan(h1Next.createdAt.getTime());

    // H2 and H3 are auto-dealt by the REAL BullMQ next-hand worker from the
    // committed outbox rows. No client DEAL is ever submitted.
    const worker = createNextHandWorker(app.prisma, app.gameManager, app.redis, app.redlock);
    workers.push(worker);
    await worker.waitUntilReady();

    let previousHandId = h1Settled.handId;
    let previousNextKey = h1NextKey;
    const expectedStacks: Record<number, { human: number; agent: number }> = {
      2: { human: 350, agent: 50 },
      3: { human: 400, agent: 0 },
    };

    for (const handNumber of [2, 3]) {
      await dispatchPendingOutbox(app.prisma, app.jobQueues, app.redis, {
        tableId: competition.tableId,
      });
      const dealt = await waitForHand(competition.tableId, handNumber);
      expect(dealt.handId).not.toBe(previousHandId);
      expect(dealt.street).toBe("PREFLOP");
      await waitForOutboxStatus(previousNextKey, "COMPLETED");

      // The sitting-out agent is never dealt a live hand: it is folded or all-in
      // from forced blinds before the human acts.
      const agent = dealt.players[agentSeat]!;
      expect(agent.isSittingOut).toBe(true);
      expect(agent.status).not.toBe("ACTIVE");
      const humanPlayer = dealt.players[humanSeat]!;
      expect(humanPlayer.status).toBe("ACTIVE");

      // The human is the only actionable player: shove/call/check it down until
      // the hand settles.
      let settledObservation: SeatObservation | undefined;
      for (let step = 0; step < 8; step++) {
        const current = await client.observation(competition.tableId);
        if (
          !current.turnId ||
          current.state.actionTo === null ||
          current.legalActions.length === 0
        ) {
          break;
        }
        settledObservation = await act(
          client,
          competition.tableId,
          ["RAISE", "BET", "CHECK", "CALL"],
          usedFamilies
        );
        if (settledObservation.state.winners) break;
      }
      expect(settledObservation).toBeDefined();
      expect(settledObservation!.state.winners).not.toBeNull();
      expect(settledObservation!.state.winners!.map((winner) => winner.seat)).toEqual([humanSeat]);
      expect(settledObservation!.state.pots).toEqual([]);

      const settled = await app.gameManager.getState(competition.tableId);
      expect(settled.players[humanSeat]!.stack).toBe(expectedStacks[handNumber].human);
      if (handNumber === 2) {
        expect(settled.players[agentSeat]?.stack).toBe(50);
      } else {
        // The eliminated seat may already have been vacated by the director.
        const agentPlayer = settled.players[agentSeat];
        expect(agentPlayer === null || agentPlayer.stack === 0).toBe(true);
      }
      expect(chipTotal(settled)).toBe(400);
      await app.prisma.gameOutbox.findUniqueOrThrow({
        where: { dedupeKey: `archive:${competition.tableId}_${settled.handId}` },
      });

      const nextKey = `next-hand:${competition.tableId}_${settled.handId}`;
      if (handNumber === 2) {
        await app.prisma.gameOutbox.findUniqueOrThrow({ where: { dedupeKey: nextKey } });
      } else {
        // With only one funded player left the table must park: no blind-deal
        // of a dead seat.
        expect(
          await app.prisma.gameOutbox.findUnique({ where: { dedupeKey: nextKey } })
        ).toBeNull();
      }
      previousHandId = settled.handId;
      previousNextKey = nextKey;
    }

    // No client DEAL was submitted after the competition start: every hand
    // advanced through the system auto-deal worker.
    expect(usedFamilies).not.toContain("DEAL");

    // Director reconciliation is the authority for the terminal competition.
    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: orchestrator.token }
    );
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);

    const readyResponse = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "GET",
      `/competitions/${competition.id}`,
      { token: orchestrator.token }
    );
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body.competition.status).toBe("RUNNING");
    expect(readyResponse.body.competition.settlementReady).toBe(true);

    const settled = await apiRequest<{
      success: boolean;
      winnerPrincipalId: string;
      winnerKind: string;
    }>(booted.baseUrl, "POST", `/competitions/${competition.id}/settle`, {
      token: orchestrator.token,
      body: {},
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.success).toBe(true);
    expect(settled.body.winnerPrincipalId).toBe(human.id);
    expect(settled.body.winnerKind).toBe("WALLET");

    const finishedResponse = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "GET",
      `/competitions/${competition.id}`,
      { token: orchestrator.token }
    );
    expect(finishedResponse.body.competition.status).toBe("FINISHED");
    expect(finishedResponse.body.competition.settlementReady).toBe(true);

    const competitionRow = await app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const entries = await app.prisma.tournamentEntry.findMany({
      where: { tournamentId: competitionRow.tournamentId },
      orderBy: { placement: "asc" },
    });
    expect(entries.find((entry) => entry.userId === human.id)?.placement).toBe(1);
    expect(entries.find((entry) => entry.userId === agentPrincipalId)?.placement).toBe(2);
  }, 120_000);
});
