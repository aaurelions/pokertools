/**
 * Adversarial generic-competition lifecycle acceptance on real PostgreSQL +
 * Redis.
 *
 * Proves the durable boundaries that the release review flagged:
 * - a concurrent `/start` burst with Redis lost still seats and deals exactly
 *   once (one SEAT_OCCUPIED event per entrant, one HAND_STARTED), and the
 *   accepted start survives an API process restart with Redis flushed;
 * - an injected engine failure mid-start rolls the whole admission back: no
 *   seat, no entry assignment, no RUNNING transition, no orphan table state;
 * - an injected engine failure mid-reconcile rolls the whole director pass
 *   back: no placement, no stand, no table close;
 * - a concurrent `/reconcile` burst with Redis lost assigns each elimination
 *   exactly one unique placement, stands each busted seat exactly once and
 *   appends no duplicate audit event.
 *
 * Everything is driven through the public HTTP surface; direct database access
 * is read-only inspection plus declared teardown. No engine state is fabricated
 * and no game outcome is written directly.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  acceptanceEnv,
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  CanonicalClient,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { flushRedis, killRedis, restartRedis } from "./infra.js";

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  startedAt: string | null;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
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
        name: `director-atomicity-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
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
        name: `director-atomicity-agent-${label}-${crypto.randomBytes(3).toString("hex")}`,
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`agent credential failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

async function createCompetition(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<CompetitionWire> {
  const response = await apiRequest<{ competition?: CompetitionWire; error?: string }>(
    baseUrl,
    "POST",
    "/competitions",
    { token, body }
  );
  if (response.status !== 201 || !response.body.competition) {
    throw new Error(
      `competition create failed: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
  return response.body.competition;
}

async function startCompetition(
  baseUrl: string,
  token: string,
  competitionId: string
): Promise<{ status: number; body: { success?: boolean; error?: string } }> {
  return apiRequest(baseUrl, "POST", `/competitions/${competitionId}/start`, { token });
}

/**
 * Heads-up bounded play: `folder` folds whenever possible, `caller` calls and
 * bets. Every action is a server-issued legal action; the loop ends when one
 * live stack remains.
 */
async function playHeadsUp(
  baseUrl: string,
  tableId: string,
  folder: { token: string },
  caller: { token: string },
  maxHands = 80
): Promise<void> {
  const folderClient = new CanonicalClient(baseUrl, {
    kind: "WALLET",
    id: "folder",
    token: folder.token,
    address: "0x0000000000000000000000000000000000000000",
    account: undefined as never,
  });
  const callerClient = new CanonicalClient(baseUrl, {
    kind: "WALLET",
    id: "caller",
    token: caller.token,
    address: "0x0000000000000000000000000000000000000000",
    account: undefined as never,
  });

  const actFor = async (client: CanonicalClient, families: readonly string[]): Promise<boolean> => {
    const observation = await client.observation(tableId);
    if (!observation.turnId || observation.legalActions.length === 0) return false;
    const legal = observation.legalActions.find((action) => families.includes(action.family));
    if (!legal) return false;
    await client.actOrThrow(tableId, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: legal.actionId,
      ...(legal.family === "BET" || legal.family === "RAISE"
        ? { amount: legal.amount ?? legal.minAmount ?? legal.maxAmount }
        : {}),
    });
    return true;
  };

  for (let hand = 0; hand < maxHands; hand++) {
    if (!(await actFor(callerClient, ["DEAL"]))) {
      await actFor(folderClient, ["DEAL"]);
    }
    for (let step = 0; step < 40; step++) {
      const callerObs = await callerClient.observation(tableId);
      if (callerObs.state.winners && callerObs.state.winners.length > 0) break;
      const acted =
        (await actFor(folderClient, ["FOLD", "CHECK", "CALL"])) ||
        (await actFor(callerClient, ["BET", "RAISE", "CALL", "CHECK"]));
      if (!acted) break;
    }
    const state = await callerClient.observation(tableId);
    const live = state.state.players.filter(
      (player: { stack: number } | null) => player && player.stack > 0
    ).length;
    if (live <= 1) return;
  }
  throw new Error("Heads-up competition did not settle within the hand budget");
}

async function seatsAndEvents(app: FastifyInstance, tableId: string) {
  const [seats, handStarts, vacates] = await Promise.all([
    app.prisma.gameEvent.count({ where: { tableId, type: "SEAT_OCCUPIED" } }),
    app.prisma.gameEvent.count({ where: { tableId, type: "HAND_STARTED" } }),
    app.prisma.gameEvent.count({ where: { tableId, type: "SEAT_VACATED" } }),
  ]);
  return { seats, handStarts, vacates };
}

/**
 * Play a seated table to a single live stack using only server-issued legal
 * actions (bounded all-in/call policy). Used to drive real eliminations on a
 * multi-table legacy tournament; no engine state is written directly.
 */
async function playToSingleStack(
  baseUrl: string,
  tableId: string,
  principals: Array<{ id: string; token: string }>
): Promise<void> {
  const clients = new Map(
    principals.map((principal) => [
      principal.id,
      new CanonicalClient(baseUrl, {
        kind: "WALLET",
        id: principal.id,
        token: principal.token,
        address: "0x0000000000000000000000000000000000000000",
        account: undefined as never,
      }),
    ])
  );
  const viewer = clients.get(principals[0]!.id)!;
  const liveCount = (observation: Awaited<ReturnType<CanonicalClient["observation"]>>): number =>
    observation.state.players.filter((player) => player && player.stack > 0).length;

  const tryDeal = async (): Promise<boolean> => {
    for (const client of clients.values()) {
      const observation = await client.observation(tableId);
      const deal = observation.legalActions.find((action) => action.family === "DEAL");
      if (!deal) continue;
      try {
        await client.actOrThrow(tableId, {
          requestId: crypto.randomUUID(),
          turnId: observation.turnId,
          expectedVersion: observation.version,
          actionId: deal.actionId,
        });
      } catch {
        // Another writer advanced the boundary first.
      }
      return true;
    }
    return false;
  };

  for (let hand = 0; hand < 40; hand++) {
    let view = await viewer.observation(tableId);
    if (view.state.actionTo === null && liveCount(view) > 1) {
      await tryDeal();
      view = await viewer.observation(tableId);
    }
    for (let step = 0; step < 300; step++) {
      view = await viewer.observation(tableId);
      if (view.state.actionTo === null && (view.state.winners?.length ?? 0) > 0) break;
      if (view.state.actionTo === null) {
        if (!(await tryDeal())) break;
        continue;
      }
      const actor = view.state.players[view.state.actionTo];
      if (!actor) break;
      const client = clients.get(actor.id);
      if (!client) throw new Error(`No client for acting principal ${actor.id}`);
      const observation = await client.observation(tableId);
      if (observation.state.actionTo === null) continue;
      const legal =
        observation.legalActions.find((action) => action.family === "RAISE") ??
        observation.legalActions.find((action) => action.family === "BET") ??
        observation.legalActions.find((action) => action.family === "CALL") ??
        observation.legalActions.find((action) => action.family === "CHECK") ??
        observation.legalActions.find((action) => action.family === "FOLD") ??
        observation.legalActions[0];
      if (!legal) break;
      const takesAmount = legal.family === "BET" || legal.family === "RAISE";
      const amount = takesAmount
        ? legal.maxAmount
        : legal.family === "CALL"
          ? legal.amount
          : undefined;
      try {
        await client.actOrThrow(tableId, {
          requestId: crypto.randomUUID(),
          turnId: observation.turnId,
          expectedVersion: observation.version,
          actionId: legal.actionId,
          ...(amount !== undefined ? { amount } : {}),
        });
      } catch {
        // Turn conflict: re-observe instead of replaying a stale request.
      }
    }
    const settled = await viewer.observation(tableId);
    if (liveCount(settled) <= 1) return;
  }
  throw new Error("Table did not settle to a single live stack");
}

async function tournamentIdFor(app: FastifyInstance, competitionId: string): Promise<string> {
  const row = await app.prisma.competition.findUniqueOrThrow({
    where: { id: competitionId },
    select: { tournamentId: true },
  });
  return row.tournamentId;
}

describe("adversarial generic lifecycle atomicity (PostgreSQL + Redis)", () => {
  let ctx: AcceptanceApp;
  let operator: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];
  /** Set only when this suite created the shared HOUSE fixture itself. */
  let createdHouseFixture = false;

  beforeAll(async () => {
    ctx = await bootApp();
    operator = await loginWallet(ctx.baseUrl);
    await promoteToOperator(ctx.app, operator.id);
  });

  /**
   * Ensure the deployment HOUSE chip-ledger operator exists for legacy
   * tournament registration. Created only when absent; teardown removes it only
   * when this suite created it, preserving shared-database isolation.
   */
  const ensureHouseFixture = async (): Promise<void> => {
    if (createdHouseFixture) return;
    const existing = await ctx.app.prisma.user.findFirst({
      where: { username: "HOUSE" },
      select: { id: true },
    });
    if (!existing) {
      await ctx.app.prisma.user.create({ data: { username: "HOUSE", role: "ADMIN" } });
      createdHouseFixture = true;
    }
  };

  afterAll(async () => {
    if (!ctx) return;
    try {
      if (competitionIds.length > 0) {
        await ctx.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
      }
      if (tableIds.length > 0) {
        await ctx.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
      }
      if (servicePrincipalIds.length > 0) {
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
        await ctx.app.prisma.session.deleteMany({
          where: { userId: { in: servicePrincipalIds } },
        });
      }
      if (createdHouseFixture) {
        // Restore shared-database isolation: the deployment HOUSE fixture is
        // created only when absent and removed again only when this suite
        // created it.
        await ctx.app.prisma.user.deleteMany({ where: { username: "HOUSE" } });
      }
    } finally {
      await ctx.close();
    }
  });

  it("seats and deals exactly once under a concurrent start burst with Redis lost, then survives a restart", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const entrants: string[] = [];
    for (let index = 0; index < 4; index++) {
      entrants.push(
        await provisionServicePrincipal(
          ctx.baseUrl,
          operator.token,
          `director-start-${index}-${crypto.randomBytes(3).toString("hex")}`,
          orchestrator.principalId
        )
      );
    }
    servicePrincipalIds.push(...entrants);

    const competition = await createCompetition(ctx.baseUrl, operator.token, {
      name: "Adversarial concurrent start",
      mode: "NONFINANCIAL",
      entrants: entrants.map((principalId) => ({ principalId, kind: "SERVICE" })),
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    // Redis is lost entirely: the start must remain correct from PostgreSQL
    // alone (the durable competition row lock and engine CAS).
    const env = acceptanceEnv();
    await killRedis(env);
    let starts: Array<{ status: number; body: { success?: boolean; error?: string } }>;
    try {
      starts = await Promise.all(
        Array.from({ length: 5 }, () =>
          startCompetition(ctx.baseUrl, operator.token, competition.id)
        )
      );
    } finally {
      await restartRedis(env);
    }
    for (const started of starts) {
      expect(started.status, JSON.stringify(started.body)).toBe(200);
    }

    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: await tournamentIdFor(ctx.app, competition.id) },
      select: { id: true, status: true, startedAt: true, entries: true },
    });
    expect(tournament.status).toBe("RUNNING");
    expect(tournament.startedAt).not.toBeNull();
    expect(tournament.entries).toHaveLength(4);
    for (const entry of tournament.entries) {
      expect(entry.status).toBe("ACTIVE");
      expect(entry.currentTableId).toBe(competition.tableId);
    }
    const { seats, handStarts } = await seatsAndEvents(ctx.app, competition.tableId);
    expect(seats).toBe(4);
    expect(handStarts).toBe(1);

    // API process restart with Redis flushed: the accepted start is durable and
    // no second seating/deal happens on replay.
    await ctx.close();
    await flushRedis(env.redisUrl);
    ctx = await bootApp();
    const replayed = await apiRequest<{ success?: boolean }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    const afterRestart = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterRestart.seats).toBe(4);
    expect(afterRestart.handStarts).toBe(1);
  });

  it("rolls an injected mid-start engine failure back completely, then starts cleanly", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const entrants: string[] = [];
    for (let index = 0; index < 4; index++) {
      entrants.push(
        await provisionServicePrincipal(
          ctx.baseUrl,
          operator.token,
          `director-fail-${index}-${crypto.randomBytes(3).toString("hex")}`,
          orchestrator.principalId
        )
      );
    }
    servicePrincipalIds.push(...entrants);

    const competition = await createCompetition(ctx.baseUrl, operator.token, {
      name: "Adversarial failed start",
      mode: "NONFINANCIAL",
      entrants: entrants.map((principalId) => ({ principalId, kind: "SERVICE" })),
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const original = ctx.app.gameManager.applyManagementMutationInTx.bind(ctx.app.gameManager);
    let calls = 0;
    const spy = vi
      .spyOn(ctx.app.gameManager, "applyManagementMutationInTx")
      .mockImplementation((async (...args: never[]) => {
        calls += 1;
        if (calls === 3) throw new Error("acceptance: injected start engine failure");
        return original(...args);
      }) as never);
    let failed: { status: number };
    try {
      failed = await startCompetition(ctx.baseUrl, operator.token, competition.id);
    } finally {
      spy.mockRestore();
    }
    expect(failed.status).toBe(500);

    // The whole admission rolled back: no RUNNING state, no active entries, no
    // seats, no deal, no orphan table.
    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: await tournamentIdFor(ctx.app, competition.id) },
      select: { status: true, startedAt: true, entries: true },
    });
    expect(tournament.status).toBe("REGISTRATION");
    expect(tournament.startedAt).toBeNull();
    for (const entry of tournament.entries) {
      expect(entry.status).toBe("REGISTERED");
      expect(entry.currentTableId).toBeNull();
      expect(entry.currentSeat).toBeNull();
    }
    const afterFailure = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterFailure.seats).toBe(0);
    expect(afterFailure.handStarts).toBe(0);
    const table = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { stateVersion: true, eventSeq: true, status: true },
    });
    expect(table.stateVersion).toBe(0);
    expect(table.eventSeq).toBe(1);
    expect(table.status).toBe("WAITING");
    const competitionRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true },
    });
    expect(competitionRow.status).toBe("REGISTRATION");
    expect(competitionRow.startedAt).toBeNull();

    // A clean retry seats and deals exactly once.
    const retried = await startCompetition(ctx.baseUrl, operator.token, competition.id);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const afterRetry = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterRetry.seats).toBe(4);
    expect(afterRetry.handStarts).toBe(1);
  });

  it("rolls an injected mid-reconcile engine failure back, then reconciles concurrently with Redis lost", async () => {
    const orchestrator = await createOrchestrator(ctx.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const [agentA, agentB] = await Promise.all([
      provisionServicePrincipal(
        ctx.baseUrl,
        operator.token,
        `director-rec-a-${crypto.randomBytes(3).toString("hex")}`,
        orchestrator.principalId
      ),
      provisionServicePrincipal(
        ctx.baseUrl,
        operator.token,
        `director-rec-b-${crypto.randomBytes(3).toString("hex")}`,
        orchestrator.principalId
      ),
    ]);
    servicePrincipalIds.push(agentA, agentB);

    const competition = await createCompetition(ctx.baseUrl, operator.token, {
      name: "Adversarial reconcile",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: agentA, kind: "SERVICE" },
        { principalId: agentB, kind: "SERVICE" },
      ],
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: crypto.randomUUID(),
    });
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const started = await startCompetition(ctx.baseUrl, operator.token, competition.id);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const tokenA = await issueAgentCredential(
      ctx.baseUrl,
      operator.token,
      competition.id,
      agentA,
      "a"
    );
    const tokenB = await issueAgentCredential(
      ctx.baseUrl,
      operator.token,
      competition.id,
      agentB,
      "b"
    );
    // Injected engine failure in the director's STAND move. The final hand's
    // automatic post-action reconcile is the first director pass that has real
    // work (the busted seat), so the injection is armed before play starts and
    // fails exactly that move; the whole director transaction must roll back
    // (no placement, no stand, no table close). All non-STAND management
    // mutations (the start's SIT/DEAL) happened before the spy was armed.
    const original = ctx.app.gameManager.applyManagementMutationInTx.bind(ctx.app.gameManager);
    let injected = 0;
    const spy = vi
      .spyOn(ctx.app.gameManager, "applyManagementMutationInTx")
      .mockImplementation((async (...args: never[]) => {
        const action = args[3] as { type?: string } | undefined;
        if (action?.type === "STAND") {
          injected += 1;
          throw new Error("acceptance: injected reconcile engine failure");
        }
        return original(...args);
      }) as never);
    try {
      await playHeadsUp(ctx.baseUrl, competition.tableId, { token: tokenA }, { token: tokenB });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBeGreaterThan(0);

    const tournamentIdAfterFailure = await tournamentIdFor(ctx.app, competition.id);
    const entriesAfterFailure = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId: tournamentIdAfterFailure },
    });
    expect(entriesAfterFailure.filter((entry) => entry.status === "ACTIVE")).toHaveLength(2);
    expect(entriesAfterFailure.every((entry) => entry.placement === null)).toBe(true);
    const afterFailure = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterFailure.vacates).toBe(0);
    // The busted seat is still durably in the engine snapshot: the failed
    // director pass did not partially remove it.
    const engineState = await ctx.app.gameManager.getState(competition.tableId);
    expect(engineState.players.filter(Boolean)).toHaveLength(2);
    expect(engineState.players.filter((player) => player && player.stack === 0)).toHaveLength(1);

    // A clean director pass assigns the elimination exactly once.
    const recoveredReconcile = await apiRequest(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: operator.token }
    );
    expect(recoveredReconcile.status, JSON.stringify(recoveredReconcile.body)).toBe(200);
    const afterRecovery = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterRecovery.vacates).toBe(1);
    const reconcileEventsAfterRecovery = await ctx.app.prisma.tournamentEvent.count({
      where: { tournamentId: tournamentIdAfterFailure, type: "TOURNAMENT_RECONCILED" },
    });

    // Concurrent reconciles with Redis lost: exactly one elimination, one
    // unique placement and one stand, no duplicate audit event.
    const env = acceptanceEnv();
    await killRedis(env);
    let reconciles: Array<{ status: number; body: unknown }>;
    try {
      reconciles = await Promise.all(
        Array.from({ length: 4 }, () =>
          apiRequest(ctx.baseUrl, "POST", `/competitions/${competition.id}/reconcile`, {
            token: operator.token,
          })
        )
      );
    } finally {
      await restartRedis(env);
    }
    for (const reconciled of reconciles) {
      expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    }

    const tournamentId = await tournamentIdFor(ctx.app, competition.id);
    const entries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId },
    });
    const eliminated = entries.filter((entry) => entry.status === "ELIMINATED");
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0].placement).toBe(2);
    const active = entries.filter((entry) => entry.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0].placement).toBeNull();
    const placements = entries
      .map((entry) => entry.placement)
      .filter((placement): placement is number => placement !== null);
    expect(new Set(placements).size).toBe(placements.length);
    const afterReconcile = await seatsAndEvents(ctx.app, competition.tableId);
    expect(afterReconcile.vacates).toBe(1);
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBe(reconcileEventsAfterRecovery);

    // The same accepted state replays without a second event or placement.
    const replay = await apiRequest(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: operator.token }
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(
      await ctx.app.prisma.tournamentEvent.count({
        where: { tournamentId, type: "TOURNAMENT_RECONCILED" },
      })
    ).toBe(reconcileEventsAfterRecovery);

    // Restart with Redis flushed and settle the accepted result exactly once.
    await ctx.close();
    await flushRedis(env.redisUrl);
    ctx = await bootApp();
    const settled = await apiRequest<{ success?: boolean; winnerPrincipalId?: string }>(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const replayedSettle = await apiRequest(
      ctx.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token }
    );
    expect(replayedSettle.status, JSON.stringify(replayedSettle.body)).toBe(200);
    const finalEntries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId },
    });
    expect(new Set(finalEntries.map((entry) => entry.placement)).size).toBe(2);
  });

  it("merges a multi-table legacy tournament under concurrent reconcile with Redis lost, without stranding a moved player", async () => {
    // Declared fixtures: the deployment HOUSE chip-ledger operator (created
    // only when absent and removed in teardown when this suite created it) and
    // funded wallet principals for a real legacy tournament.
    await ensureHouseFixture();
    const players = await Promise.all([
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
    ]);
    for (const player of players) {
      await ctx.app.financialManager.grantChips(player.id, 5000, {
        reason: "test_fixture",
        operatorId: player.id,
        idempotencyKey: `director-multitable-grant-${player.id}`,
      });
    }

    const created = await apiRequest<{ tournamentId: string; tableId: string }>(
      ctx.baseUrl,
      "POST",
      "/tournaments",
      {
        token: players[0].token,
        body: {
          name: "Adversarial multi-table director",
          buyIn: 100,
          fee: 0,
          startingStack: 1000,
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 4,
          tableMaxPlayers: 2,
          payoutPercentages: [100],
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { tournamentId, tableId: primaryTableId } = created.body;
    tableIds.push(primaryTableId);

    for (const [seat, player] of players.entries()) {
      const registered = await apiRequest(
        ctx.baseUrl,
        "POST",
        `/tournaments/${tournamentId}/register`,
        { token: player.token, body: { seat, idempotencyKey: crypto.randomUUID() } }
      );
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    }

    const started = await apiRequest<{ tableIds: string[]; distribution: number[] }>(
      ctx.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/start`,
      { token: players[0].token }
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.distribution).toEqual([2, 2]);
    const [tableOne, tableTwo] = started.body.tableIds;
    tableIds.push(...started.body.tableIds.filter((id) => id !== primaryTableId));

    const tokenById = new Map(players.map((player) => [player.id, player.token]));
    const principalsFor = async (tableId: string) => {
      const entries = await ctx.app.prisma.tournamentEntry.findMany({
        where: { tournamentId, currentTableId: tableId },
      });
      return entries.map((entry) => ({ id: entry.userId, token: tokenById.get(entry.userId)! }));
    };

    // Table 1 completes first: its busted player is eliminated and stood.
    await playToSingleStack(ctx.baseUrl, tableOne, await principalsFor(tableOne));

    // Arm the failure: the first director SIT (the merge move of table 2's
    // winner) throws, rolling the whole auto-reconcile transaction back.
    const original = ctx.app.gameManager.applyManagementMutationInTx.bind(ctx.app.gameManager);
    let injected = 0;
    const spy = vi
      .spyOn(ctx.app.gameManager, "applyManagementMutationInTx")
      .mockImplementation((async (...args: never[]) => {
        const action = args[3] as { type?: string } | undefined;
        if (action?.type === "SIT") {
          injected += 1;
          throw new Error("acceptance: injected merge SIT failure");
        }
        return original(...args);
      }) as never);
    try {
      await playToSingleStack(ctx.baseUrl, tableTwo, await principalsFor(tableTwo));
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBeGreaterThan(0);

    // The failed merge rolled back completely: table 2 still holds both
    // players and no placement was persisted for its busted player.
    const afterFailure = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId, currentTableId: tableTwo },
    });
    expect(afterFailure).toHaveLength(2);
    expect(afterFailure.every((entry) => entry.placement === null)).toBe(true);
    expect(
      (
        await ctx.app.prisma.table.findUniqueOrThrow({
          where: { id: tableTwo },
          select: { status: true },
        })
      ).status
    ).toBe("ACTIVE");

    // Concurrent reconciles with Redis lost: placements, the busted stand, the
    // merge move and the table close each happen exactly once.
    const env = acceptanceEnv();
    await killRedis(env);
    let reconciles: Array<{ status: number }>;
    try {
      reconciles = await Promise.all(
        Array.from({ length: 4 }, () =>
          apiRequest(ctx.baseUrl, "POST", `/tournaments/${tournamentId}/reconcile`, {
            token: players[0].token,
          })
        )
      );
    } finally {
      await restartRedis(env);
    }
    for (const reconciled of reconciles) {
      expect(reconciled.status).toBe(200);
    }

    const finalEntries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId },
    });
    const eliminated = finalEntries.filter((entry) => entry.status === "ELIMINATED");
    expect(eliminated).toHaveLength(2);
    expect(eliminated.map((entry) => entry.placement ?? 0).sort((a, b) => a - b)).toEqual([3, 4]);
    const active = finalEntries.filter((entry) => entry.status === "ACTIVE");
    expect(active).toHaveLength(2);
    for (const entry of active) {
      expect(entry.currentTableId).toBe(primaryTableId);
    }
    expect(
      (
        await ctx.app.prisma.table.findUniqueOrThrow({
          where: { id: tableTwo },
          select: { status: true },
        })
      ).status
    ).toBe("CLOSED");
    // Exactly one merge SIT on the final table and no duplicated moves.
    expect((await seatsAndEvents(ctx.app, primaryTableId)).seats).toBe(3);
    expect((await seatsAndEvents(ctx.app, tableOne)).vacates).toBe(1);
    expect((await seatsAndEvents(ctx.app, tableTwo)).vacates).toBe(2);

    // Restart with Redis flushed: the merged layout is durable.
    await ctx.close();
    await flushRedis(env.redisUrl);
    ctx = await bootApp();
    const durableEntries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId },
    });
    expect(
      durableEntries
        .filter((entry) => entry.status === "ACTIVE")
        .every((entry) => entry.currentTableId === primaryTableId)
    ).toBe(true);
  });

  it("persists and settles a prize pool above 2^31 chips from three valid int32 buy-ins", async () => {
    await ensureHouseFixture();
    const players = await Promise.all([
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
      loginWallet(ctx.baseUrl),
    ]);
    const grant = 5_000_000_000;
    const buyIn = 1_000_000_000;
    for (const player of players) {
      await ctx.app.financialManager.grantChips(player.id, grant, {
        reason: "test_fixture",
        operatorId: player.id,
        idempotencyKey: `director-bigint-grant-${player.id}`,
      });
    }

    const created = await apiRequest<{ tournamentId: string; tableId: string }>(
      ctx.baseUrl,
      "POST",
      "/tournaments",
      {
        token: players[0].token,
        body: {
          name: "BigInt prize pool",
          buyIn,
          fee: 0,
          startingStack: buyIn,
          smallBlind: 1_000_000,
          bigBlind: 2_000_000,
          maxPlayers: 3,
          tableMaxPlayers: 3,
          payoutPercentages: [100],
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const { tournamentId, tableId } = created.body;
    tableIds.push(tableId);

    for (const [seat, player] of players.entries()) {
      const registered = await apiRequest(
        ctx.baseUrl,
        "POST",
        `/tournaments/${tournamentId}/register`,
        { token: player.token, body: { seat, idempotencyKey: crypto.randomUUID() } }
      );
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    }

    const started = await apiRequest(ctx.baseUrl, "POST", `/tournaments/${tournamentId}/start`, {
      token: players[0].token,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // Play to a single live stack using only server-issued canonical actions.
    await playToSingleStack(
      ctx.baseUrl,
      tableId,
      players.map((player) => ({ id: player.id, token: player.token }))
    );
    const reconciled = await apiRequest(
      ctx.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/reconcile`,
      { token: players[0].token }
    );
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);

    const settled = await apiRequest<{
      success?: boolean;
      winnerUserId?: string;
      prize?: number;
      payouts?: Array<{ userId: string; placement: number; amount: number }>;
    }>(ctx.baseUrl, "POST", `/tournaments/${tournamentId}/settle`, { token: players[0].token });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.prize).toBe(3_000_000_000);
    expect(Number.isSafeInteger(settled.body.prize)).toBe(true);
    expect(settled.body.payouts).toEqual([
      { userId: settled.body.winnerUserId, placement: 1, amount: 3_000_000_000 },
    ]);

    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
      select: { status: true, prizePool: true },
    });
    expect(tournament.status).toBe("FINISHED");
    expect(tournament.prizePool).toBe(3_000_000_000n);
    const winnerEntry = await ctx.app.prisma.tournamentEntry.findFirstOrThrow({
      where: { tournamentId, placement: 1 },
    });
    expect(winnerEntry.userId).toBe(settled.body.winnerUserId);
    expect(winnerEntry.prize).toBe(3_000_000_000n);
    const loserEntries = await ctx.app.prisma.tournamentEntry.findMany({
      where: { tournamentId, placement: { not: 1 } },
    });
    expect(loserEntries.every((entry) => entry.prize === 0n)).toBe(true);
    const winnerAccount = await ctx.app.prisma.chipAccount.findFirstOrThrow({
      where: { principalId: settled.body.winnerUserId!, kind: "AVAILABLE" },
      select: { balance: true },
    });
    expect(winnerAccount.balance).toBe(BigInt(grant - buyIn + 3_000_000_000));
  });
});
