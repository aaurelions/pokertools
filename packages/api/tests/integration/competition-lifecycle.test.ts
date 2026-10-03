/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  initTestContext,
  runCleanup,
  createTable,
  getObservation,
  executeAction,
  getTableState,
  type TestContext,
  type TestUser,
} from "../helpers/test-utils.js";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";

/**
 * Generic competition capability regression coverage (route-level).
 *
 * Runs against the real Fastify app and disposable SQLite + Redis. Direct
 * database/service access is limited to declared fixtures (operator promotion,
 * asset provisioning, sponsor funding via the real atomic ledger); gameplay and
 * competition mutations go through the public HTTP routes only.
 *
 * Paid (ASSET) admission is fail-closed on the central platform readiness and
 * an explicit feature flag. Positive paid lifecycle and exact atomic journals
 * are proven in the PostgreSQL acceptance suite with real readiness evidence;
 * this file covers the gates, zero-financial free play, credential confinement
 * and atomic-admission no-orphan behavior.
 */

const ASSET_ID = "eip155:31337/erc20:0x1111111111111111111111111111111111111111";
const TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";

interface Actor {
  token: string;
}

interface ApiResult<T> {
  statusCode: number;
  body: T;
}

async function inject<T = unknown>(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  options: { token?: string; payload?: unknown } = {}
): Promise<ApiResult<T>> {
  const response = await app.inject({
    method,
    url,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  let body: unknown = undefined;
  if (response.body.length > 0) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return { statusCode: response.statusCode, body: body as T };
}

/** Declared fixture: register the test asset in the asset registry. */
async function ensureAsset(app: FastifyInstance): Promise<void> {
  await app.prisma.asset.upsert({
    where: { id: ASSET_ID },
    update: { status: "ACTIVE" },
    create: {
      id: ASSET_ID,
      chainId: 31337,
      tokenAddress: TOKEN_ADDRESS,
      symbol: "TST",
      decimals: 6,
      status: "ACTIVE",
      confirmations: 1,
      deepFinality: 2,
      treasuryAddress: TREASURY,
      rpcUrls: [],
      minGasAtomic: "0",
    },
  });
}

/** Declared fixture: fund a principal's atomic balance from the treasury reserve. */
async function fundAtomic(
  app: FastifyInstance,
  ownerId: string,
  amountAtomic: string,
  label: string
): Promise<void> {
  const ledger = new AtomicLedger(app.prisma);
  const from = await ledger.ensureAccount(app.prisma, {
    assetId: ASSET_ID,
    ownerId: null,
    class: "TREASURY_RESERVE",
  });
  const to = await ledger.ensureAccount(app.prisma, {
    assetId: ASSET_ID,
    ownerId,
    class: "USER_AVAILABLE",
  });
  await ledger.postAtomic({
    requestId: `fixture-fund:${label}`,
    assetId: ASSET_ID,
    postings: [
      { accountId: from.accountId, amountAtomic: `-${amountAtomic}` },
      { accountId: to.accountId, amountAtomic },
    ],
  });
}

async function createOrchestrator(
  app: FastifyInstance,
  operatorToken: string
): Promise<{ principalId: string; credentialId: string; token: string }> {
  const response = await inject<{ id: string; userId: string; token: string }>(
    app,
    "POST",
    "/auth/service-credentials",
    {
      token: operatorToken,
      payload: {
        name: `orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.statusCode !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return {
    principalId: response.body.userId,
    credentialId: response.body.id,
    token: response.body.token,
  };
}

async function provisionServicePrincipal(
  app: FastifyInstance,
  operatorToken: string,
  name: string,
  delegatedToPrincipalId?: string
): Promise<string> {
  const response = await inject<{ principalId: string }>(app, "POST", "/auth/service-principals", {
    token: operatorToken,
    payload: delegatedToPrincipalId ? { name, delegatedToPrincipalId } : { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`service principal failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.principalId;
}

function entrant(principalId: string, kind: "WALLET" | "SERVICE") {
  return { principalId, kind };
}

async function issueAgentCredential(
  app: FastifyInstance,
  orchestratorToken: string,
  competitionId: string,
  principalId: string,
  credentialId?: string,
  seat?: number
): Promise<{ token: string; credentialId: string; principalId: string; seat: number | null }> {
  const issued = await inject<{
    token: string;
    credentialId: string;
    principalId: string;
    seat: number | null;
  }>(app, "POST", `/competitions/${competitionId}/agent-credentials`, {
    token: orchestratorToken,
    payload: {
      principalId,
      name: `agent-room-${crypto.randomBytes(3).toString("hex")}`,
      ...(credentialId ? { credentialId } : {}),
      ...(seat !== undefined ? { seat } : {}),
    },
  });
  if (issued.statusCode !== (credentialId ? 200 : 201)) {
    throw new Error(`agent credential failed: ${JSON.stringify(issued.body)}`);
  }
  return issued.body;
}

/** Play heads-up until one stack remains: `folder` folds, `caller` calls. */
async function playHeadsUpUntilSettled(
  app: FastifyInstance,
  tableId: string,
  folder: Actor,
  caller: Actor,
  maxHands = 80
): Promise<void> {
  let lastDebug: unknown = null;
  const folderFamilies = ["FOLD", "CHECK", "CALL"] as const;
  const callerFamilies = ["BET", "RAISE", "CALL", "CHECK"] as const;

  for (let hand = 0; hand < maxHands; hand++) {
    const callerObs = await getObservation(app, caller.token, tableId);
    if (callerObs.legalActions.some((action) => action.family === "DEAL")) {
      await executeAction(app, caller.token, tableId, { type: "DEAL" });
    } else {
      const folderObs = await getObservation(app, folder.token, tableId);
      if (folderObs.legalActions.some((action) => action.family === "DEAL")) {
        await executeAction(app, folder.token, tableId, { type: "DEAL" });
      }
    }

    for (let step = 0; step < 40; step++) {
      const state = await getTableState(app, caller.token, tableId);
      if (state.winners && state.winners.length > 0) break;

      const folderObs = await getObservation(app, folder.token, tableId);
      const callerObsNow = await getObservation(app, caller.token, tableId);
      lastDebug = {
        handNumber: state.handNumber,
        actionTo: state.actionTo,
        folder: { turnId: folderObs.turnId, families: folderObs.legalActions.map((a) => a.family) },
        caller: {
          turnId: callerObsNow.turnId,
          families: callerObsNow.legalActions.map((a) => a.family),
        },
      };

      let acted = false;
      for (const [actor, observation, families] of [
        [folder, folderObs, folderFamilies],
        [caller, callerObsNow, callerFamilies],
      ] as const) {
        if (!observation.turnId || observation.legalActions.length === 0) continue;
        const family = families.find((candidate) =>
          observation.legalActions.some((action) => action.family === candidate)
        );
        if (family) {
          await executeAction(app, actor.token, tableId, { type: family });
          acted = true;
        }
        break;
      }
      if (!acted) break;
    }

    const state = await getTableState(app, caller.token, tableId);
    const live = state.players.filter(
      (player: { stack: number } | null) => player && player.stack > 0
    ).length;
    if (live <= 1) return;
  }
  throw new Error(`Heads-up competition did not settle: ${JSON.stringify(lastDebug)}`);
}

function assetTerms(sponsorPrincipalId: string, prizeAmountAtomic = "5000") {
  return {
    entry: {
      assetId: ASSET_ID,
      amountAtomic: "1000",
      payers: [] as Array<{ principalId: string }>,
    },
    prize: { assetId: ASSET_ID, amountAtomic: prizeAmountAtomic, sponsorPrincipalId },
  };
}

describe("competition capability", () => {
  let ctx: TestContext;
  let operator: TestUser;
  let payer: TestUser;
  let spectator: TestUser;
  const createdCompetitionIds: string[] = [];
  const createdTableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  const paidFlag = {
    get enabled() {
      return ctx.app.competitionPolicy.paidEnabled;
    },
    set enabled(v: boolean) {
      ctx.app.competitionPolicy.paidEnabled = v;
    },
  };

  beforeAll(async () => {
    ctx = await initTestContext(3, 1000);
    [payer, spectator] = ctx.users;
    operator = ctx.users[2];
    await ctx.app.prisma.user.update({ where: { id: operator.id }, data: { role: "ADMIN" } });
    await ensureAsset(ctx.app);
    await fundAtomic(ctx.app, operator.id, "100000000", "sponsor-main");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx.app.prisma.competition
      .deleteMany({ where: { id: { in: createdCompetitionIds } } })
      .catch(() => undefined);
    if (createdTableIds.length > 0) {
      await ctx.app.prisma.table
        .deleteMany({ where: { id: { in: createdTableIds } } })
        .catch(() => undefined);
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
    await ctx.app.prisma.competitionEntrant
      .deleteMany({ where: { principalId: { in: servicePrincipalIds } } })
      .catch(() => undefined);
    await ctx.app.prisma.tournamentEntry
      .deleteMany({ where: { userId: { in: servicePrincipalIds } } })
      .catch(() => undefined);
    await ctx.app.prisma.user
      .deleteMany({ where: { id: { in: servicePrincipalIds } } })
      .catch(() => undefined);
    await ctx.app.prisma.journalPosting.deleteMany({ where: { assetId: ASSET_ID } });
    await ctx.app.prisma.journalTransaction.deleteMany({ where: { assetId: ASSET_ID } });
    await ctx.app.prisma.atomicAccount.deleteMany({ where: { assetId: ASSET_ID } });
    await ctx.app.prisma.asset.deleteMany({ where: { id: ASSET_ID } });
    await runCleanup(ctx.cleanup);
  });

  it("provisions and finishes a NONFINANCIAL mixed competition with zero journal movement", async () => {
    const orchestrator = await createOrchestrator(ctx.app, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `agent-nf-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const payload = {
      name: "Free mixed",
      mode: "NONFINANCIAL",
      entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
      smallBlind: 100,
      bigBlind: 200,
      idempotencyKey: crypto.randomUUID(),
    };

    const chipEntriesBefore = await ctx.app.prisma.chipLedgerEntry.count();
    const journalsBefore = await ctx.app.prisma.journalTransaction.count();

    const created = await inject<{
      competition: {
        id: string;
        tableId: string;
        mode: string;
        settlementReady: boolean;
        entrants: Array<{ principalId: string; seat: number; entryState: string }>;
      };
      replayed: boolean;
    }>(ctx.app, "POST", "/competitions", { token: orchestrator.token, payload });
    expect(created.statusCode).toBe(201);
    expect(created.body.replayed).toBe(false);
    expect(created.body.competition.settlementReady).toBe(false);
    const competitionId = created.body.competition.id;
    const tableId = created.body.competition.tableId;
    createdCompetitionIds.push(competitionId);
    createdTableIds.push(tableId);
    expect(created.body.competition.entrants.map((entry) => entry.seat).sort()).toEqual([0, 1]);
    expect(
      created.body.competition.entrants.every((entry) => entry.entryState === "NOT_REQUIRED")
    ).toBe(true);

    // Identical request replays the original result exactly (no duplicate roster).
    const replay = await inject<{ replayed: boolean; competition: { id: string } }>(
      ctx.app,
      "POST",
      "/competitions",
      { token: orchestrator.token, payload }
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.competition.id).toBe(competitionId);
    expect(await ctx.app.prisma.competitionEntrant.count({ where: { competitionId } })).toBe(2);

    const started = await inject(ctx.app, "POST", `/competitions/${competitionId}/start`, {
      token: orchestrator.token,
    });
    expect(started.statusCode).toBe(200);

    // Atomic start: every entrant is seated before the competition is public.
    const startedRow = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competitionId },
      select: { status: true, startedAt: true },
    });
    expect(startedRow.status).toBe("RUNNING");
    expect(startedRow.startedAt).not.toBeNull();
    const state = await getTableState(ctx.app, payer.token, tableId);
    expect(state.players.filter(Boolean)).toHaveLength(2);

    // Free competition: no chip journal, no asset journal, no prize pool.
    expect(await ctx.app.prisma.chipLedgerEntry.count()).toBe(chipEntriesBefore);
    expect(await ctx.app.prisma.journalTransaction.count()).toBe(journalsBefore);
    const table = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: tableId },
      select: { mode: true, tournamentId: true },
    });
    expect(table.mode).toBe("TOURNAMENT");
    expect(table.tournamentId).not.toBeNull();
    const tournament = await ctx.app.prisma.tournament.findUniqueOrThrow({
      where: { id: table.tournamentId! },
      select: { buyIn: true, fee: true, prizePool: true },
    });
    expect(tournament).toEqual({ buyIn: 0, fee: 0, prizePool: 0n });

    // Outsiders cannot use table-level admission/exit on a competition roster.
    const outsiderBuyIn = await inject(ctx.app, "POST", `/tables/${tableId}/buy-in`, {
      token: spectator.token,
      payload: { amount: 100, seat: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(outsiderBuyIn.statusCode).toBe(403);
    expect((outsiderBuyIn.body as { error?: string }).error).toBe("COMPETITION_MANAGED_TABLE");
    const rosterStand = await inject(ctx.app, "POST", `/tables/${tableId}/stand`, {
      token: payer.token,
    });
    expect(rosterStand.statusCode).toBe(403);
    expect((rosterStand.body as { error?: string }).error).toBe("COMPETITION_MANAGED_TABLE");

    // Finish the free competition through the authoritative lifecycle.
    const agentCredential = await issueAgentCredential(
      ctx.app,
      orchestrator.token,
      competitionId,
      agent
    );
    await playHeadsUpUntilSettled(ctx.app, tableId, { token: agentCredential.token }, payer);
    const reconciled = await inject(ctx.app, "POST", `/competitions/${competitionId}/reconcile`, {
      token: orchestrator.token,
    });
    expect(reconciled.statusCode).toBe(200);
    const settled = await inject<{ prizeStatus: string; prize: unknown }>(
      ctx.app,
      "POST",
      `/competitions/${competitionId}/settle`,
      { token: orchestrator.token }
    );
    expect(settled.statusCode).toBe(200);
    expect(settled.body.prizeStatus).toBe("NOT_APPLICABLE");
    expect(settled.body.prize).toBeNull();
    expect(await ctx.app.prisma.chipLedgerEntry.count()).toBe(chipEntriesBefore);
    expect(await ctx.app.prisma.journalTransaction.count()).toBe(journalsBefore);

    const finishedProjection = await inject<{
      competition: { status: string; settlementReady: boolean };
    }>(ctx.app, "GET", `/competitions/${competitionId}`, { token: payer.token });
    expect(finishedProjection.statusCode).toBe(200);
    expect(finishedProjection.body.competition.status).toBe("FINISHED");
    expect(finishedProjection.body.competition.settlementReady).toBe(true);

    // Settled competition tables reject public gameplay.
    const postSettleAction = await inject<{ error?: string }>(
      ctx.app,
      "POST",
      `/tables/${tableId}/action`,
      {
        token: payer.token,
        payload: {
          requestId: crypto.randomUUID(),
          turnId: "turn-1",
          expectedVersion: 0,
          actionId: "action-1",
        },
      }
    );
    expect(postSettleAction.statusCode).toBe(409);
    const postSettleCode =
      (postSettleAction.body as { code?: string; error?: string }).code ??
      (postSettleAction.body as { error?: string }).error;
    expect(postSettleCode).toBe("COMPETITION_NOT_ACTIONABLE");
  });

  it("rejects paid admission while the explicit feature enable is off, with no orphan rows", async () => {
    const orchestrator = await createOrchestrator(ctx.app, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `agent-gate-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const tablesBefore = await ctx.app.prisma.table.count();
    const competitionsBefore = await ctx.app.prisma.competition.count();

    const terms = assetTerms(operator.id);
    terms.entry.payers = [{ principalId: payer.id }];
    const created = await inject<{ error?: string }>(ctx.app, "POST", "/competitions", {
      token: orchestrator.token,
      payload: {
        name: "Paid disabled",
        mode: "ASSET",
        entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
        smallBlind: 100,
        bigBlind: 200,
        terms,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(created.statusCode).toBe(503);
    expect(created.body.error).toBe("COMPETITION_PAID_DISABLED");

    // Atomic admission: nothing was created, not even a transient table.
    expect(await ctx.app.prisma.table.count()).toBe(tablesBefore);
    expect(await ctx.app.prisma.competition.count()).toBe(competitionsBefore);
  });

  it("fails paid admission closed when financial readiness is not READY", async () => {
    const orchestrator = await createOrchestrator(ctx.app, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `agent-ready-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    paidFlag.enabled = true;
    try {
      vi.spyOn(ctx.app.platformReadiness, "evaluate").mockResolvedValue({
        financial: { state: "NOT_READY", reasons: ["ASSET_LEDGER_UNVERIFIED"], checks: [] },
      } as never);

      const terms = assetTerms(operator.id);
      terms.entry.payers = [{ principalId: payer.id }];
      const created = await inject<{ error?: string }>(ctx.app, "POST", "/competitions", {
        token: orchestrator.token,
        payload: {
          name: "Paid not ready",
          mode: "ASSET",
          entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
          smallBlind: 100,
          bigBlind: 200,
          terms,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      expect(created.statusCode).toBe(503);
      expect(created.body.error).toBe("COMPETITION_FINANCIAL_NOT_READY");
      expect(await ctx.app.prisma.competition.count({ where: { name: "Paid not ready" } })).toBe(0);
    } finally {
      paidFlag.enabled = false;
      vi.restoreAllMocks();
    }
  });

  it("keeps orchestration and agent credentials narrowly scoped and rotatable", async () => {
    const orchestrator = await createOrchestrator(ctx.app, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);

    // No finance, credential-administration, principal, user or tournament access.
    const blocked: Array<[string, "GET" | "POST", unknown]> = [
      ["/finance/balances", "GET", undefined],
      ["/auth/service-credentials", "GET", undefined],
      ["/auth/service-principals", "POST", { name: "nope" }],
      ["/user/me", "GET", undefined],
      ["/tournaments", "GET", undefined],
    ];
    for (const [url, method, payload] of blocked) {
      const response = await inject(ctx.app, method, url, {
        token: orchestrator.token,
        payload,
      });
      expect(response.statusCode).toBe(403);
    }

    // A table-scoped credential can never reach competition orchestration.
    // Table-scoped credentials are always bound to a real table.
    const scopeTableId = await createTable(ctx.app, payer.token, {
      name: "Scope table",
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 4,
    });
    createdTableIds.push(scopeTableId);
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `agent-scope-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);
    const tableCredential = await inject<{ token: string }>(
      ctx.app,
      "POST",
      "/auth/service-credentials",
      {
        token: operator.token,
        payload: {
          principalId: agent,
          name: "plain-table",
          scopes: ["table:observe"],
          tableId: scopeTableId,
        },
      }
    );
    expect(tableCredential.statusCode).toBe(201);
    const forbidden = await inject(ctx.app, "POST", "/competitions", {
      token: tableCredential.body.token,
      payload: {
        name: "nope",
        mode: "NONFINANCIAL",
        entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(forbidden.statusCode).toBe(403);

    // Agent credentials are bound to the competition table and rotate in place.
    const created = await inject<{ competition: { id: string; tableId: string } }>(
      ctx.app,
      "POST",
      "/competitions",
      {
        token: orchestrator.token,
        payload: {
          name: "Credential room",
          mode: "NONFINANCIAL",
          entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
          smallBlind: 100,
          bigBlind: 200,
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.statusCode).toBe(201);
    const competitionId = created.body.competition.id;
    const tableId = created.body.competition.tableId;
    createdCompetitionIds.push(competitionId);
    createdTableIds.push(tableId);

    // The table must be live for the seat-restricted credential to resolve its
    // authoritative persisted seat.
    const started = await inject(ctx.app, "POST", `/competitions/${competitionId}/start`, {
      token: orchestrator.token,
    });
    expect(started.statusCode).toBe(200);

    const issued = await issueAgentCredential(ctx.app, orchestrator.token, competitionId, agent);
    expect(issued.principalId).toBe(agent);

    const rotated = await issueAgentCredential(
      ctx.app,
      orchestrator.token,
      competitionId,
      agent,
      issued.credentialId
    );
    expect(rotated.principalId).toBe(agent);
    const oldToken = await inject(ctx.app, "GET", `/tables/${tableId}/observation`, {
      token: issued.token,
    });
    expect(oldToken.statusCode).toBe(401);
    const newToken = await inject(ctx.app, "GET", `/tables/${tableId}/observation`, {
      token: rotated.token,
    });
    expect(newToken.statusCode).toBe(200);
  });

  it("issues table-only agent credentials by default and validates explicit seats", async () => {
    const orchestrator = await createOrchestrator(ctx.app, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `agent-seat-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const created = await inject<{
      competition: {
        id: string;
        tableId: string;
        entrants: Array<{ principalId: string; seat: number }>;
      };
    }>(ctx.app, "POST", "/competitions", {
      token: orchestrator.token,
      payload: {
        name: "Credential seat semantics",
        mode: "NONFINANCIAL",
        entrants: [entrant(payer.id, "WALLET"), entrant(agent, "SERVICE")],
        smallBlind: 100,
        bigBlind: 200,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(created.statusCode).toBe(201);
    const competitionId = created.body.competition.id;
    const tableId = created.body.competition.tableId;
    createdCompetitionIds.push(competitionId);
    createdTableIds.push(tableId);
    const started = await inject(ctx.app, "POST", `/competitions/${competitionId}/start`, {
      token: orchestrator.token,
    });
    expect(started.statusCode).toBe(200);
    const agentSeat = created.body.competition.entrants.find(
      (candidate) => candidate.principalId === agent
    )!.seat;

    // Omitted seat: table-only credential, no seat restriction.
    const tableOnly = await issueAgentCredential(ctx.app, orchestrator.token, competitionId, agent);
    expect(tableOnly.seat).toBeNull();
    const tableOnlyObservation = await inject(ctx.app, "GET", `/tables/${tableId}/observation`, {
      token: tableOnly.token,
    });
    expect(tableOnlyObservation.statusCode).toBe(200);

    // Table-only is still narrowly bound: no other table access.
    const otherTableId = await createTable(ctx.app, payer.token, {
      name: "Other table",
      mode: "CASH",
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 4,
    });
    createdTableIds.push(otherTableId);
    const foreignTable = await inject(ctx.app, "GET", `/tables/${otherTableId}/observation`, {
      token: tableOnly.token,
    });
    expect(foreignTable.statusCode).toBe(403);
    expect((foreignTable.body as { error?: string }).error).toBe("TABLE_RESTRICTED");

    // Explicit seat must equal the entrant's authoritative seat.
    const seated = await issueAgentCredential(
      ctx.app,
      orchestrator.token,
      competitionId,
      agent,
      undefined,
      agentSeat
    );
    expect(seated.seat).toBe(agentSeat);
    const wrongSeat = agentSeat === 0 ? 1 : 0;
    const mismatch = await inject<{ error?: string }>(
      ctx.app,
      "POST",
      `/competitions/${competitionId}/agent-credentials`,
      {
        token: orchestrator.token,
        payload: {
          principalId: agent,
          name: "wrong-seat",
          seat: wrongSeat,
        },
      }
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error).toBe("COMPETITION_AGENT_CREDENTIAL_SEAT_MISMATCH");

    // Rotation preserves omitted scopes instead of broadening to the default.
    const observeOnly = await inject<{ token: string; credentialId: string; scopes: string[] }>(
      ctx.app,
      "POST",
      `/competitions/${competitionId}/agent-credentials`,
      {
        token: orchestrator.token,
        payload: { principalId: agent, name: "observe-only", scopes: ["table:observe"] },
      }
    );
    expect(observeOnly.statusCode).toBe(201);
    expect(observeOnly.body.scopes).toEqual(["table:observe"]);
    const rotatedObserve = await inject<{ token: string; scopes: string[] }>(
      ctx.app,
      "POST",
      `/competitions/${competitionId}/agent-credentials`,
      {
        token: orchestrator.token,
        payload: {
          principalId: agent,
          name: "observe-only",
          credentialId: observeOnly.body.credentialId,
        },
      }
    );
    expect(rotatedObserve.statusCode).toBe(200);
    expect(rotatedObserve.body.scopes).toEqual(["table:observe"]);
    const rotatedObserveAccess = await inject(ctx.app, "GET", `/tables/${tableId}/observation`, {
      token: rotatedObserve.body.token,
    });
    expect(rotatedObserveAccess.statusCode).toBe(200);
    const oldObserveToken = await inject(ctx.app, "GET", `/tables/${tableId}/observation`, {
      token: observeOnly.body.token,
    });
    expect(oldObserveToken.statusCode).toBe(401);
  });
});
