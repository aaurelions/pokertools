/**
 * Competition prestart cancellation acceptance on real PostgreSQL + Redis.
 *
 * Proves the HTTP contracts end to end against the deployment database and
 * migration manifest:
 * - a paid entry is held in the competition's own `competition-entry:<id>`
 *   reserve and only transferred to the sponsor at start, so the sponsor can
 *   never spend refundable value;
 * - cancellation refunds every held entry exactly, releases the prize,
 *   cancels the backing tournament, closes its table and is idempotent from
 *   durable state with a truthful per-entry refund report;
 * - `REGISTRATION -> RUNNING` and `REGISTRATION -> CANCELLED` are serialized so
 *   exactly one wins, and a concurrent opt-in can never pay after
 *   cancellation/start;
 * - a durably started competition replays start after settlement, and a paid
 *   opt-in replays from its exact journal before the registration gate.
 *
 * Readiness is evaluated for real; the chain-quorum probe is the only seam.
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

const ASSET_ID = "eip155:31337/erc20:0x9999999999999999999999999999999999999999";
const TOKEN_ADDRESS = "0x9999999999999999999999999999999999999999";
const TREASURY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const CHAIN_QUORUM_TEST_PROBE = {
  async verifyQuorum() {
    return { ok: true as const, code: "RPC_QUORUM_OK", chainsChecked: 1 };
  },
};

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  cancelledAt: string | null;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
}

interface CancelWire {
  success: boolean;
  competitionId: string;
  status: string;
  cancelledAt: string;
  prizeStatus: string;
  prize: { assetId: string; amountAtomic: string } | null;
  entries: Array<{
    principalId: string;
    kind: string;
    entryState: string;
    refunded: boolean;
    refundJournalId: string | null;
  }>;
}

function createAsset(app: FastifyInstance): Promise<unknown> {
  return app.prisma.asset.upsert({
    where: { id: ASSET_ID },
    update: { status: "ACTIVE" },
    create: {
      id: ASSET_ID,
      chainId: 31337,
      tokenAddress: TOKEN_ADDRESS,
      symbol: "CXL",
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
      evidence: { source: "competition-cancellation-acceptance" },
    },
  });
  await app.prisma.custodyHeartbeat.create({
    data: {
      chainId: 31337,
      signerAddress: TREASURY,
      signerReady: true,
      gasReady: true,
      workerId: "competition-cancellation-worker",
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
    requestId: `cancel-acceptance-fund:${label}`,
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
      body: { principalId, name: `cancel-agent-${crypto.randomBytes(3).toString("hex")}` },
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

/**
 * Declared fixture: a PAID entry whose committed journal credits the sponsor's
 * OPERATOR account instead of the competition entry reserve. It is malformed
 * canonical evidence and must be refused, never accepted.
 */
async function seedForeignEntryJournal(
  app: FastifyInstance,
  input: { competitionId: string; payerId: string; sponsorId: string; amountAtomic: string }
): Promise<string> {
  const ledger = new AtomicLedger(app.prisma);
  const from = await ledger.ensureAccount(app.prisma, {
    assetId: ASSET_ID,
    ownerId: input.payerId,
    class: "USER_AVAILABLE",
  });
  const to = await ledger.ensureAccount(app.prisma, {
    assetId: ASSET_ID,
    ownerId: input.sponsorId,
    class: "OPERATOR",
  });
  const requestId = `competition-entry:${input.competitionId}:${input.payerId}`;
  await ledger.postAtomic({
    requestId,
    assetId: ASSET_ID,
    postings: [
      { accountId: from.accountId, amountAtomic: `-${input.amountAtomic}` },
      { accountId: to.accountId, amountAtomic: input.amountAtomic },
    ],
  });
  await app.prisma.competitionEntrant.update({
    where: {
      competitionId_principalId: {
        competitionId: input.competitionId,
        principalId: input.payerId,
      },
    },
    data: { entryState: "PAID", entryJournalId: requestId },
  });
  return requestId;
}

describe("competition cancellation acceptance (PostgreSQL + Redis)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  let payer: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    booted = await bootApp({ readiness: { chainQuorum: CHAIN_QUORUM_TEST_PROBE } });
    payer = await loginWallet(booted.baseUrl);
    operator = await loginWallet(booted.baseUrl);
    await promoteToOperator(booted.app, operator.id);
    await createAsset(booted.app);
    await seedReadinessEvidence(booted.app);
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
    await booted.close();
  });

  async function createPaidCompetition(name: string): Promise<CompetitionWire> {
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `cancel-acceptance-agent-${crypto.randomBytes(3).toString("hex")}`,
      operator.id
    );
    servicePrincipalIds.push(agent);
    const created = await apiRequest<{ competition?: CompetitionWire; error?: string }>(
      booted.baseUrl,
      "POST",
      "/competitions",
      {
        token: operator.token,
        body: {
          name,
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
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition!;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);
    return competition;
  }

  it("holds entries in the competition reserve, refunds and releases exactly once, and replays durably", async () => {
    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await atomicBalance(booted.app, operator.id, "OPERATOR");
    const competition = await createPaidCompetition("Acceptance cancel refund");
    const entryReserveKey = `competition-entry:${competition.id}`;
    const prizeReserveKey = `competition-prize:${competition.id}`;

    // Create reserves the prize but holds nothing else.
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", prizeReserveKey)).toBe(
      5000n
    );
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(0n);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n);

    // Opt-in holds the exact entry in the competition reserve, not the sponsor.
    const optIn = await apiRequest<{ journalRequestId: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(optIn.status, JSON.stringify(optIn.body)).toBe(200);
    expect(optIn.body.journalRequestId).toBe(
      `competition-entry-reserve:${competition.id}:${payer.id}`
    );
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n);
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(
      1000n
    );

    // Paid opt-in replay is a no-op with the exact journal evidence, and a
    // stale idempotencyKey is rejected instead of ignored.
    const replay = await apiRequest<{ journalRequestId: string; entryState: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.entryState).toBe("PAID");
    expect(replay.body.journalRequestId).toBe(optIn.body.journalRequestId);
    const stale = await apiRequest<{ error?: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token, body: { idempotencyKey: "stale-1" } }
    );
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe("VALIDATION_FAILED");
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);

    const journalCountBefore = await booted.app.prisma.journalTransaction.count({
      where: { assetId: ASSET_ID },
    });
    const cancelled = await apiRequest<CancelWire>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/cancel`,
      { token: operator.token }
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect(cancelled.body.prizeStatus).toBe("RELEASED");
    expect(cancelled.body.prize).toEqual({ assetId: ASSET_ID, amountAtomic: "5000" });
    const payerEntry = cancelled.body.entries.find((entry) => entry.principalId === payer.id)!;
    expect(payerEntry.entryState).toBe("REFUNDED");
    expect(payerEntry.refunded).toBe(true);
    expect(payerEntry.refundJournalId).toBe(
      `competition-entry-refund:${competition.id}:${payer.id}`
    );
    const agentEntry = cancelled.body.entries.find((entry) => entry.kind === "SERVICE")!;
    expect(agentEntry).toMatchObject({
      entryState: "NOT_REQUIRED",
      refunded: false,
      refundJournalId: null,
    });

    // Exact economics: payer and sponsor made whole, both reserves empty.
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(sponsorBefore);
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(0n);
    expect(await atomicBalance(booted.app, null, "TOURNAMENT_RESERVE", prizeReserveKey)).toBe(0n);

    // Durable close of the backing machinery.
    const row = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: {
        status: true,
        cancelledAt: true,
        prizeStatus: true,
        tournament: { select: { status: true } },
      },
    });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.prizeStatus).toBe("RELEASED");
    expect(row.tournament.status).toBe("CANCELLED");
    expect(
      (
        await booted.app.prisma.table.findUniqueOrThrow({
          where: { id: competition.tableId },
          select: { status: true },
        })
      ).status
    ).toBe("CLOSED");

    // Idempotent replay: identical durable projection, no new journals.
    const replayCancel = await apiRequest<CancelWire>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/cancel`,
      { token: operator.token }
    );
    expect(replayCancel.status).toBe(200);
    expect(replayCancel.body).toEqual(cancelled.body);
    expect(await booted.app.prisma.journalTransaction.count({ where: { assetId: ASSET_ID } })).toBe(
      journalCountBefore + 2
    );

    // Post-cancel: the accepted charge receipt stays replayable (live state is
    // REFUNDED, no second charge), and start is closed.
    const lateOptIn = await apiRequest<{ entryState: string; journalRequestId: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(lateOptIn.status, JSON.stringify(lateOptIn.body)).toBe(200);
    expect(lateOptIn.body.entryState).toBe("REFUNDED");
    expect(lateOptIn.body.journalRequestId).toBe(optIn.body.journalRequestId);
    const lateStart = await apiRequest<{ error?: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(lateStart.status).toBe(409);
    expect(lateStart.body.error).toBe("COMPETITION_NOT_REGISTERING");
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
  });

  it("replays start after settlement and replays a paid opt-in before the registration gate", async () => {
    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await atomicBalance(booted.app, operator.id, "OPERATOR");
    const competition = await createPaidCompetition("Acceptance start replay");
    const agent = (
      await booted.app.prisma.competitionEntrant.findFirstOrThrow({
        where: { competitionId: competition.id, kind: "SERVICE" },
        select: { principalId: true },
      })
    ).principalId;

    const optIn = await apiRequest<{ journalRequestId: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(optIn.status).toBe(200);
    const started = await apiRequest<{ seats: Array<{ seat: number }> }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(
      sponsorBefore - 5000n + 1000n
    );

    // Paid opt-in replay before the registration gate: exact journal evidence.
    const optInReplay = await apiRequest<{ journalRequestId: string; entryState: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(optInReplay.status, JSON.stringify(optInReplay.body)).toBe(200);
    expect(optInReplay.body.entryState).toBe("PAID");
    expect(optInReplay.body.journalRequestId).toBe(optIn.body.journalRequestId);

    // The paying wallet folds; the zero-entry SERVICE agent wins the prize back
    // to the sponsor, then start must still replay from the durable marker.
    const agentToken = await issueAgentCredential(
      booted.baseUrl,
      operator.token,
      competition.id,
      agent
    );
    await playHeadsUp(booted.baseUrl, competition.tableId, payer, { token: agentToken });
    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: operator.token }
    );
    expect(reconciled.status).toBe(200);
    const settled = await apiRequest<{ prizeStatus: string }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: operator.token }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.prizeStatus).toBe("RELEASED");

    const startReplay = await apiRequest<{ seats: Array<{ seat: number }> }>(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(startReplay.status, JSON.stringify(startReplay.body)).toBe(200);
    expect(startReplay.body.seats.map((seat) => seat.seat).sort()).toEqual([0, 1]);

    // Settled ASSET competition: payer net -1000 (entry transferred at start),
    // sponsor net +1000 (entry kept, prize released).
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(sponsorBefore + 1000n);
  });

  it("serializes concurrent start and cancel with exactly one winner", async () => {
    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const competition = await createPaidCompetition("Acceptance start cancel race");
    const optIn = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(optIn.status).toBe(200);

    const [startResponse, cancelResponse] = await Promise.all([
      apiRequest<{ error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/start`,
        { token: operator.token }
      ),
      apiRequest<{ error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/cancel`,
        { token: operator.token }
      ),
    ]);
    expect(
      [startResponse.status, cancelResponse.status].sort(),
      JSON.stringify([startResponse.body, cancelResponse.body])
    ).toEqual([200, 409]);

    const row = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true, cancelledAt: true },
    });
    if (row.status === "RUNNING") {
      expect(row.startedAt).not.toBeNull();
      expect(cancelResponse.status).toBe(409);
      expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
      expect(
        await atomicBalance(
          booted.app,
          null,
          "TOURNAMENT_RESERVE",
          `competition-entry:${competition.id}`
        )
      ).toBe(0n);
    } else {
      expect(row.status).toBe("CANCELLED");
      expect(row.cancelledAt).not.toBeNull();
      expect(startResponse.status).toBe(409);
      expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
      expect(
        (
          await booted.app.prisma.competitionEntrant.findFirstOrThrow({
            where: { competitionId: competition.id, principalId: payer.id },
            select: { entryState: true },
          })
        ).entryState
      ).toBe("REFUNDED");
    }
  });

  it("serializes concurrent opt-in and cancel so no value is ever charged after cancellation", async () => {
    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");
    const competition = await createPaidCompetition("Acceptance opt-in cancel race");

    const [optInResponse, cancelResponse] = await Promise.all([
      apiRequest<{ error?: string; entryState?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/opt-in`,
        { token: payer.token }
      ),
      apiRequest<CancelWire>(booted.baseUrl, "POST", `/competitions/${competition.id}/cancel`, {
        token: operator.token,
      }),
    ]);
    expect(cancelResponse.status, JSON.stringify(cancelResponse.body)).toBe(200);

    const row = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: {
        status: true,
        entrants: {
          where: { principalId: payer.id },
          select: { entryState: true, entryJournalId: true, refundJournalId: true },
        },
      },
    });
    expect(row.status).toBe("CANCELLED");
    const entrant = row.entrants[0];
    const reported = cancelResponse.body.entries.find((entry) => entry.principalId === payer.id)!;
    if (optInResponse.status === 200) {
      // The charge committed first and cancellation refunded it exactly.
      expect(entrant.entryState).toBe("REFUNDED");
      expect(entrant.refundJournalId).toBe(
        `competition-entry-refund:${competition.id}:${payer.id}`
      );
      expect(reported.entryState).toBe("REFUNDED");
      expect(reported.refunded).toBe(true);
    } else {
      // Cancellation won the race: the opt-in is rejected with no charge, and
      // the response truthfully reports the never-paid entry.
      expect(optInResponse.status).toBe(409);
      expect(entrant.entryState).toBe("PENDING");
      expect(entrant.entryJournalId).toBeNull();
      expect(reported.entryState).toBe("PENDING");
      expect(reported.refunded).toBe(false);
      expect(reported.refundJournalId).toBeNull();
    }
    // Either way the payer is made whole and the report matches durable state.
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    expect(reported.refundJournalId).toBe(entrant.refundJournalId);
  });

  it("refuses malformed entry evidence on real PostgreSQL without moving value", async () => {
    const sponsorBefore = await atomicBalance(booted.app, operator.id, "OPERATOR");
    const competition = await createPaidCompetition("Acceptance malformed evidence");
    // Declared fixture: the entry journal credits the sponsor's operator
    // account, not the competition entry reserve — never canonical evidence.
    await seedForeignEntryJournal(booted.app, {
      competitionId: competition.id,
      payerId: payer.id,
      sponsorId: operator.id,
      amountAtomic: "1000",
    });

    for (const path of ["cancel", "start"] as const) {
      const blocked = await apiRequest<{ error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/${path}`,
        { token: operator.token }
      );
      expect(blocked.status, `${path}: ${JSON.stringify(blocked.body)}`).toBe(409);
      expect(blocked.body.error).toBe("COMPETITION_ENTRY_UNRESOLVED");
    }

    const row = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true, cancelledAt: true },
    });
    expect(row).toEqual({ status: "REGISTRATION", startedAt: null, cancelledAt: null });
    expect(
      await booted.app.prisma.journalTransaction.count({
        where: {
          requestId: {
            in: [
              `competition-entry-refund:${competition.id}:${payer.id}`,
              `competition-entry-release:${competition.id}:${payer.id}`,
            ],
          },
        },
      })
    ).toBe(0);
    expect(await atomicBalance(booted.app, operator.id, "OPERATOR")).toBe(
      sponsorBefore - 5000n + 1000n
    );
    expect(
      await atomicBalance(
        booted.app,
        null,
        "TOURNAMENT_RESERVE",
        `competition-prize:${competition.id}`
      )
    ).toBe(5000n);
  });
});
