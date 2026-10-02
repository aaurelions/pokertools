/**
 * Generic competition acceptance on real PostgreSQL + Redis.
 *
 * Proves the platform capability against the actual deployment database and
 * migration manifest:
 * - NONFINANCIAL mixed WALLET/SERVICE play moves zero chip-journal and zero
 *   asset-journal value;
 * - ASSET admission reserves the sponsor prize atomically, charges the exact
 *   entry once, seats every entrant in one transaction, and settles the prize
 *   exactly once (PAID to a WALLET winner, RELEASED when no financial winner);
 * - paid admission fails closed when the central platform readiness is not
 *   READY, even with an ACTIVE asset, and never creates an orphan table.
 *
 * Readiness is evaluated for real against the provisioned database. The only
 * test seam is the chain-quorum probe: this suite has no live RPC endpoints,
 * so it injects a probe into the composition root (production wires the real
 * registry from `Asset.rpcUrls`). Custody/gas evidence, reconciliation and
 * ledger invariants are real rows/invariants in PostgreSQL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  CanonicalClient,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { AtomicLedger } from "../../../src/services/atomic-ledger.js";

const ASSET_ID = "eip155:31337/erc20:0x3333333333333333333333333333333333333333";
const TOKEN_ADDRESS = "0x3333333333333333333333333333333333333333";
const TREASURY = "0x4444444444444444444444444444444444444444";

const CHAIN_QUORUM_TEST_PROBE = {
  async verifyQuorum() {
    return { ok: true as const, code: "RPC_QUORUM_OK", chainsChecked: 1 };
  },
};

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  mode: string;
  startedAt: string | null;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
}

function createAsset(app: FastifyInstance): Promise<unknown> {
  return app.prisma.asset.upsert({
    where: { id: ASSET_ID },
    update: { status: "ACTIVE" },
    create: {
      id: ASSET_ID,
      chainId: 31337,
      tokenAddress: TOKEN_ADDRESS,
      symbol: "ACC",
      decimals: 6,
      status: "ACTIVE",
      confirmations: 1,
      deepFinality: 2,
      treasuryAddress: TREASURY,
      rpcUrls: ["http://127.0.0.1:1"],
      minGasAtomic: "0",
    },
  });
}

/** Real durable readiness evidence: reconciliation + custody/gas heartbeats. */
async function seedReadinessEvidence(app: FastifyInstance): Promise<void> {
  await app.prisma.treasuryReconciliation.create({
    data: {
      assetId: ASSET_ID,
      chainId: 31337,
      observedAtomic: "0",
      ledgerAtomic: "0",
      differenceAtomic: "0",
      blockNumber: "1",
      status: "MATCHED",
      evidence: { source: "competition-acceptance" },
    },
  });
  await app.prisma.custodyHeartbeat.create({
    data: {
      chainId: 31337,
      signerAddress: TREASURY,
      signerReady: true,
      gasReady: true,
      workerId: "competition-acceptance-worker",
      observedAt: new Date(),
    },
  });
}

async function fundAtomicClass(
  app: FastifyInstance,
  ownerId: string,
  accountClass: "USER_AVAILABLE" | "OPERATOR",
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
    class: accountClass,
  });
  await ledger.postAtomic({
    requestId: `acceptance-fund:${label}`,
    assetId: ASSET_ID,
    postings: [
      { accountId: from.accountId, amountAtomic: `-${amountAtomic}` },
      { accountId: to.accountId, amountAtomic },
    ],
  });
}

async function atomicBalance(
  app: FastifyInstance,
  ownerId: string | null,
  accountClass: "USER_AVAILABLE" | "OPERATOR" | "TOURNAMENT_RESERVE",
  ownerKey?: string
): Promise<bigint> {
  const account = await app.prisma.atomicAccount.findFirst({
    where: { assetId: ASSET_ID, class: accountClass, ...(ownerKey ? { ownerKey } : { ownerId }) },
  });
  return account ? BigInt(account.balanceAtomic) : 0n;
}

async function createOrchestrator(
  baseUrl: string,
  operatorToken: string
): Promise<{ principalId: string; credentialId: string; token: string }> {
  const response = await apiRequest<{ id: string; userId: string; token: string }>(
    baseUrl,
    "POST",
    "/auth/service-credentials",
    {
      token: operatorToken,
      body: {
        name: `acceptance-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return {
    principalId: response.body.userId,
    credentialId: response.body.id,
    token: response.body.token,
  };
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

async function createCompetition(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: { competition?: CompetitionWire; error?: string } }> {
  const response = await apiRequest<{ competition?: CompetitionWire; error?: string }>(
    baseUrl,
    "POST",
    "/competitions",
    { token, body }
  );
  return { status: response.status, body: response.body };
}

async function issueAgentCredential(
  baseUrl: string,
  token: string,
  competitionId: string,
  principalId: string
): Promise<string> {
  const response = await apiRequest<{ token: string }>(
    baseUrl,
    "POST",
    `/competitions/${competitionId}/agent-credentials`,
    {
      token,
      body: { principalId, name: `acceptance-agent-${crypto.randomBytes(3).toString("hex")}` },
    }
  );
  if (response.status !== 201) {
    throw new Error(`agent credential failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

/** Play heads-up: `folder` folds whenever possible, `caller` calls/bets. */
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
    // Deal the next hand if the server offers DEAL at the boundary.
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

describe("competition acceptance (PostgreSQL + Redis)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  let payer: WalletPrincipal;
  let spectator: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    booted = await bootApp({ readiness: { chainQuorum: CHAIN_QUORUM_TEST_PROBE } });
    [payer, spectator] = await Promise.all([
      loginWallet(booted.baseUrl),
      loginWallet(booted.baseUrl),
    ]);
    operator = await loginWallet(booted.baseUrl);
    await promoteToOperator(booted.app, operator.id);
    await createAsset(booted.app);
    await seedReadinessEvidence(booted.app);
    // Sponsor prize account and the paying wallet's available balance.
    await fundAtomicClass(booted.app, operator.id, "OPERATOR", "100000000", "sponsor");
    await fundAtomicClass(booted.app, payer.id, "USER_AVAILABLE", "100000", "payer");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await booted.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    if (tableIds.length > 0) {
      await booted.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
    }
    await booted.app.prisma.servicePrincipalDelegation.deleteMany({
      where: {
        OR: [
          { servicePrincipalId: { in: servicePrincipalIds } },
          { delegatePrincipalId: { in: servicePrincipalIds } },
        ],
      },
    });
    await booted.app.prisma.serviceCredential.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.session.deleteMany({ where: { userId: { in: servicePrincipalIds } } });
    await booted.app.prisma.competitionEntrant.deleteMany({
      where: { principalId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.tournamentEntry.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.user.deleteMany({ where: { id: { in: servicePrincipalIds } } });
    // Ledger postings are append-only in PostgreSQL and are disposed with the
    // private acceptance database. Readiness evidence (custody heartbeat +
    // reconciliation) is retained: the shared suite's ledger/asset probes
    // evaluate every ACTIVE asset, so removing one asset's evidence would make
    // financial readiness fail closed for later files.
    await booted.close();
  });

  it("runs a NONFINANCIAL mixed competition with zero journal movement", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `acceptance-agent-free-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const chipEntriesBefore = await booted.app.prisma.chipLedgerEntry.count();
    const journalsBefore = await booted.app.prisma.journalTransaction.count();

    const created = await createCompetition(booted.baseUrl, orchestrator.token, {
      name: "Acceptance free mixed",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: payer.id, kind: "WALLET" },
        { principalId: agent, kind: "SERVICE" },
      ],
      smallBlind: 100,
      bigBlind: 200,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const competition = created.body.competition!;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const started = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      {
        token: orchestrator.token,
        body: { idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(started.status).toBe(200);

    // Atomic start: the competition is public only once fully seated.
    const fresh = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true },
    });
    expect(fresh.status).toBe("RUNNING");
    expect(fresh.startedAt).not.toBeNull();

    // Real PostgreSQL: no chip journal and no asset journal for free play.
    expect(await booted.app.prisma.chipLedgerEntry.count()).toBe(chipEntriesBefore);
    expect(await booted.app.prisma.journalTransaction.count()).toBe(journalsBefore);

    // Outsider admission/exit through generic table routes is rejected.
    const outsiderBuyIn = await apiRequest(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/buy-in`,
      {
        token: spectator.token,
        body: { amount: 100, seat: 0, idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(outsiderBuyIn.status).toBe(403);
  });

  it("reserves, charges and pays exactly once for an authorized sponsor outside the roster", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `acceptance-agent-paid-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await atomicBalance(booted.app, operator.id, "OPERATOR");

    // The sponsor (operator wallet) is NOT on the roster: authorized
    // organizer-as-wallet delegation must still succeed.
    const created = await createCompetition(booted.baseUrl, operator.token, {
      name: "Acceptance asset paid",
      mode: "ASSET",
      entrants: [
        { principalId: payer.id, kind: "WALLET" },
        { principalId: agent, kind: "SERVICE" },
      ],
      smallBlind: 100,
      bigBlind: 200,
      terms: {
        entry: {
          assetId: ASSET_ID,
          amountAtomic: "1000",
          payers: [{ principalId: payer.id }],
        },
        prize: { assetId: ASSET_ID, amountAtomic: "5000", sponsorPrincipalId: operator.id },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition!;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const reserveKey = `competition-prize:${competition.id}`;
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", reserveKey)).toBe(5000n);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n);

    // Start is fail-closed until the configured payer opts in.
    const prematureStart = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(prematureStart.status).toBe(409);
    expect((prematureStart.body as { error?: string }).error).toBe("COMPETITION_ENTRY_UNPAID");

    const optInKey = crypto.randomUUID();
    const optIn = await apiRequest<{ entry: { amountAtomic: string } }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token, body: { idempotencyKey: optInKey } }
    );
    expect(optIn.status).toBe(200);
    expect(optIn.body.entry.amountAtomic).toBe("1000");
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(
      sponsorBefore - 5000n + 1000n
    );

    const replay = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      {
        token: payer.token,
        body: { idempotencyKey: optInKey },
      }
    );
    expect(replay.status).toBe(200);
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);

    const started = await apiRequest<{ seats: Array<{ seat: number }> }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(started.status).toBe(200);
    expect(started.body.seats.map((seat) => seat.seat).sort()).toEqual([0, 1]);

    // The zero-entry SERVICE agent folds; the paying wallet wins the prize.
    const agentToken = await issueAgentCredential(
      booted.baseUrl,
      operator.token,
      competition.id,
      agent
    );
    await playHeadsUp(booted.baseUrl, competition.tableId, { token: agentToken }, payer);

    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: operator.token }
    );
    expect(reconciled.status).toBe(200);

    const settled = await apiRequest<{
      winnerPrincipalId: string;
      prizeStatus: string;
      prize: { amountAtomic: string } | null;
    }>(booted.baseUrl, "POST", `/competitions/${competition.id}/settle`, {
      token: operator.token,
      body: { idempotencyKey: crypto.randomUUID() },
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.winnerPrincipalId).toBe(payer.id);
    expect(settled.body.prizeStatus).toBe("PAID");
    expect(settled.body.prize?.amountAtomic).toBe("5000");
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(
      payerBefore - 1000n + 5000n
    );
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", reserveKey)).toBe(0n);

    // Repeated settlement never pays a second prize.
    const replayed = await apiRequest<{ prizeStatus: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(replayed.status).toBe(200);
    expect(replayed.body.prizeStatus).toBe("PAID");
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(
      payerBefore - 1000n + 5000n
    );
  });

  it("releases the reserved prize to the sponsor when no financial winner exists", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `acceptance-agent-win-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await atomicBalance(booted.app, operator.id, "OPERATOR");

    const created = await createCompetition(booted.baseUrl, operator.token, {
      name: "Acceptance service win",
      mode: "ASSET",
      entrants: [
        { principalId: payer.id, kind: "WALLET" },
        { principalId: agent, kind: "SERVICE" },
      ],
      smallBlind: 100,
      bigBlind: 200,
      terms: {
        entry: { assetId: ASSET_ID, amountAtomic: "1000", payers: [{ principalId: payer.id }] },
        prize: { assetId: ASSET_ID, amountAtomic: "5000", sponsorPrincipalId: operator.id },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const competition = created.body.competition!;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const optIn = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      {
        token: payer.token,
        body: { idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(optIn.status).toBe(200);
    const started = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      {
        token: operator.token,
        body: { idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(started.status).toBe(200);

    // The paying wallet folds; the zero-entry SERVICE agent wins.
    const agentToken = await issueAgentCredential(
      booted.baseUrl,
      operator.token,
      competition.id,
      agent
    );
    await playHeadsUp(booted.baseUrl, competition.tableId, payer, { token: agentToken });

    const settled = await apiRequest<{ winnerKind: string; prizeStatus: string; prize: unknown }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token, body: { idempotencyKey: crypto.randomUUID() } }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.winnerKind).toBe("SERVICE");
    expect(settled.body.prizeStatus).toBe("RELEASED");
    expect(settled.body.prize).toBeNull();
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(
      sponsorBefore - 5000n + 1000n + 5000n
    );
    expect(
      await atomicBalance(
        booted.app,
        null,
        "TOURNAMENT_RESERVE",
        `competition-prize:${competition.id}`
      )
    ).toBe(0n);
    expect(await atomicBalance(booted.app, agent, "USER_AVAILABLE")).toBe(0n);
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
  });

  it("fails paid admission closed when platform readiness is not READY even with an ACTIVE asset", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `acceptance-agent-blocked-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const tablesBefore = await booted.app.prisma.table.count();
    const competitionsBefore = await booted.app.prisma.competition.count();

    vi.spyOn(booted.app.platformReadiness, "evaluate").mockResolvedValue({
      financial: { state: "BLOCKED", reasons: ["ASSET_LEDGER_UNVERIFIED"], checks: [] },
    } as never);

    const created = await createCompetition(booted.baseUrl, operator.token, {
      name: "Acceptance blocked",
      mode: "ASSET",
      entrants: [
        { principalId: payer.id, kind: "WALLET" },
        { principalId: agent, kind: "SERVICE" },
      ],
      smallBlind: 100,
      bigBlind: 200,
      terms: {
        entry: { assetId: ASSET_ID, amountAtomic: "1000", payers: [{ principalId: payer.id }] },
        prize: { assetId: ASSET_ID, amountAtomic: "5000", sponsorPrincipalId: operator.id },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status).toBe(503);
    expect(created.body.error).toBe("COMPETITION_FINANCIAL_NOT_READY");

    // Atomic admission: no orphan table or competition was created.
    expect(await booted.app.prisma.table.count()).toBe(tablesBefore);
    expect(await booted.app.prisma.competition.count()).toBe(competitionsBefore);

    vi.restoreAllMocks();
  });

  it("disposes the reserved prize when the tournament settled before competition disposition (crash window)", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `acceptance-agent-crash-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const created = await createCompetition(booted.baseUrl, operator.token, {
      name: "Acceptance crash window",
      mode: "ASSET",
      entrants: [
        { principalId: payer.id, kind: "WALLET" },
        { principalId: agent, kind: "SERVICE" },
      ],
      smallBlind: 100,
      bigBlind: 200,
      terms: {
        entry: { assetId: ASSET_ID, amountAtomic: "1000", payers: [{ principalId: payer.id }] },
        prize: { assetId: ASSET_ID, amountAtomic: "5000", sponsorPrincipalId: operator.id },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition!;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const optIn = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      {
        token: payer.token,
        body: { idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(optIn.status).toBe(200);
    const started = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      {
        token: operator.token,
        body: { idempotencyKey: crypto.randomUUID() },
      }
    );
    expect(started.status).toBe(200);
    const agentToken = await issueAgentCredential(
      booted.baseUrl,
      operator.token,
      competition.id,
      agent
    );
    await playHeadsUp(booted.baseUrl, competition.tableId, { token: agentToken }, payer);
    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: operator.token }
    );
    expect(reconciled.status).toBe(200);

    // Crash-equivalent durable state: the authoritative tournament settlement
    // committed, but the process died before the competition prize disposition.
    const row = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    const tournamentSettle = await apiRequest(
      booted.baseUrl,
      "POST",
      `/tournaments/${row.tournamentId}/settle`,
      { token: operator.token }
    );
    expect(tournamentSettle.status, JSON.stringify(tournamentSettle.body)).toBe(200);

    const reserveKey = `competition-prize:${competition.id}`;
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", reserveKey)).toBe(5000n);

    // Concurrent retries must both replay the same settlement and pay once.
    const settleBody = { idempotencyKey: crypto.randomUUID() };
    const [settled, replayedSettle] = await Promise.all([
      apiRequest<{ prizeStatus?: string; error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/settle`,
        { token: operator.token, body: settleBody }
      ),
      apiRequest<{ prizeStatus?: string; error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/settle`,
        { token: operator.token, body: settleBody }
      ),
    ]);
    expect(
      settled.status,
      `reserve after retry: ${await atomicBalance(
        booted.app,
        null,
        "TOURNAMENT_RESERVE",
        reserveKey
      )} body=${JSON.stringify(settled.body)}`
    ).toBe(200);
    expect(replayedSettle.status, JSON.stringify(replayedSettle.body)).toBe(200);
    expect(settled.body.prizeStatus).toBe("PAID");
    expect(replayedSettle.body.prizeStatus).toBe("PAID");
    expect(
      await booted.app.prisma.journalTransaction.count({
        where: { requestId: `competition-prize-payout:${competition.id}` },
      })
    ).toBe(1);
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", reserveKey)).toBe(0n);
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(
      payerBefore - 1000n + 5000n
    );
  });
});
