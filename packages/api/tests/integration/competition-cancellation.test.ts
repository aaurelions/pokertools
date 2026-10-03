/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  initTestContext,
  runCleanup,
  type TestContext,
  type TestUser,
} from "../helpers/test-utils.js";
import { AtomicLedger } from "../../src/services/atomic-ledger.js";

/**
 * Prestart cancellation, held-entry reserves and natural idempotency (route
 * level, disposable SQLite + Redis).
 *
 * The decisive economics invariant: a paid entry is held by the competition
 * itself (`competition-entry:<id>` reserve) and only transferred to the sponsor
 * when the competition starts. Cancellation therefore refunds every held entry
 * exactly and releases the prize even when the sponsor has already spent its
 * balance — and it works while paid admission is disabled and financial
 * readiness is BLOCKED (risk-reducing).
 *
 * Malformed canonical evidence (a PAID entry whose journal credited something
 * other than the competition entry reserve) is simulated as a declared fixture
 * and must be refused as a whole, never accepted and never "refunded" by
 * inventing funding.
 */

const ASSET_ID = "eip155:31337/erc20:0x7777777777777777777777777777777777777777";
const TOKEN_ADDRESS = "0x7777777777777777777777777777777777777777";
const TREASURY = "0x8888888888888888888888888888888888888888";

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

async function ensureAsset(app: FastifyInstance): Promise<void> {
  await app.prisma.asset.upsert({
    where: { id: ASSET_ID },
    update: { status: "ACTIVE" },
    create: {
      id: ASSET_ID,
      chainId: 31337,
      tokenAddress: TOKEN_ADDRESS,
      symbol: "CNL",
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

async function fundAtomic(
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
    requestId: `fixture-fund:${label}`,
    assetId: ASSET_ID,
    postings: [
      { accountId: from.accountId, amountAtomic: `-${amountAtomic}` },
      { accountId: to.accountId, amountAtomic },
    ],
  });
}

async function balanceOf(
  app: FastifyInstance,
  ownerId: string | null,
  accountClass: "USER_AVAILABLE" | "OPERATOR" | "TOURNAMENT_RESERVE",
  ownerKey?: string
): Promise<bigint> {
  const account = await app.prisma.atomicAccount.findFirst({
    where: {
      assetId: ASSET_ID,
      class: accountClass,
      ...(ownerKey ? { ownerKey } : { ownerId }),
    },
  });
  return account ? BigInt(account.balanceAtomic) : 0n;
}

async function provisionServicePrincipal(
  app: FastifyInstance,
  operatorToken: string,
  name: string,
  delegatedToPrincipalId: string
): Promise<string> {
  const response = await inject<{ principalId: string }>(app, "POST", "/auth/service-principals", {
    token: operatorToken,
    payload: { name, delegatedToPrincipalId },
  });
  if (response.statusCode !== 201) {
    throw new Error(`service principal failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.principalId;
}

interface CompetitionWire {
  id: string;
  tableId: string;
  status: string;
  cancelledAt: string | null;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
}

function assetTerms(
  sponsorPrincipalId: string,
  payerPrincipalId: string,
  prizeAmountAtomic = "5000"
) {
  return {
    entry: {
      assetId: ASSET_ID,
      amountAtomic: "1000",
      payers: [{ principalId: payerPrincipalId }],
    },
    prize: { assetId: ASSET_ID, amountAtomic: prizeAmountAtomic, sponsorPrincipalId },
  };
}

describe("competition prestart cancellation", () => {
  let ctx: TestContext;
  let operator: TestUser;
  let payer: TestUser;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
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
    ctx = await initTestContext(2, 1000);
    [payer] = ctx.users;
    operator = ctx.users[1];
    await ctx.app.prisma.user.update({ where: { id: operator.id }, data: { role: "ADMIN" } });
    await ensureAsset(ctx.app);
    await fundAtomic(ctx.app, operator.id, "OPERATOR", "100000000", "cancel-sponsor");
    await fundAtomic(ctx.app, payer.id, "USER_AVAILABLE", "100000", "cancel-payer");
    paidFlag.enabled = true;
    vi.spyOn(ctx.app.platformReadiness, "evaluate").mockResolvedValue({
      financial: { state: "READY", reasons: [], checks: [] },
    } as never);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    paidFlag.enabled = false;
    await ctx.app.prisma.competition
      .deleteMany({ where: { id: { in: competitionIds } } })
      .catch(() => undefined);
    if (tableIds.length > 0) {
      await ctx.app.prisma.table
        .deleteMany({ where: { id: { in: tableIds } } })
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

  async function createAssetCompetition(
    orchestratorToken: string,
    agentPrincipalId: string,
    name: string
  ): Promise<CompetitionWire> {
    const created = await inject<{ competition: CompetitionWire; error?: string }>(
      ctx.app,
      "POST",
      "/competitions",
      {
        token: orchestratorToken,
        payload: {
          name,
          mode: "ASSET",
          entrants: [
            { principalId: payer.id, kind: "WALLET" },
            { principalId: agentPrincipalId, kind: "SERVICE" },
          ],
          smallBlind: 100,
          bigBlind: 200,
          terms: assetTerms(operator.id, payer.id),
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    competitionIds.push(created.body.competition.id);
    tableIds.push(created.body.competition.tableId);
    return created.body.competition;
  }

  it("holds a paid entry in the competition reserve, releases it once at start, and refuses post-start cancellation", async () => {
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `cancel-agent-${crypto.randomBytes(3).toString("hex")}`,
      operator.id
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await balanceOf(ctx.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await balanceOf(ctx.app, operator.id, "OPERATOR");
    const competition = await createAssetCompetition(operator.token, agent, "Held entry");
    const entryReserveKey = `competition-entry:${competition.id}`;
    const prizeReserveKey = `competition-prize:${competition.id}`;

    // Opt-in moves the exact entry into the competition reserve, not the sponsor.
    const optIn = await inject(ctx.app, "POST", `/competitions/${competition.id}/opt-in`, {
      token: payer.token,
    });
    expect(optIn.statusCode, JSON.stringify(optIn.body)).toBe(200);
    expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
    expect(await balanceOf(ctx.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n);
    expect(await balanceOf(ctx.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(1000n);

    // A stale idempotencyKey is rejected, never ignored.
    const staleBody = await inject<{ error?: string }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token, payload: { idempotencyKey: "stale-1" } }
    );
    expect(staleBody.statusCode).toBe(400);
    expect(staleBody.body.error).toBe("VALIDATION_FAILED");

    // Natural replay: no body, no second charge, exact journal evidence.
    const replay = await inject<{ journalRequestId: string; entryState: string }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body.entryState).toBe("PAID");
    expect(replay.body.journalRequestId).toBe(
      `competition-entry-reserve:${competition.id}:${payer.id}`
    );
    expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);

    const started = await inject(ctx.app, "POST", `/competitions/${competition.id}/start`, {
      token: operator.token,
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(200);
    expect(await balanceOf(ctx.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(0n);
    expect(await balanceOf(ctx.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n + 1000n);

    // Prestart-only: a started competition can never be cancelled.
    const cancelAfterStart = await inject<{ error?: string }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/cancel`,
      { token: operator.token }
    );
    expect(cancelAfterStart.statusCode).toBe(409);
    expect(cancelAfterStart.body.error).toBe("COMPETITION_NOT_CANCELLABLE");

    // A durably started competition replays start from durable state.
    const startReplay = await inject<{ seats: Array<{ seat: number }> }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(startReplay.statusCode).toBe(200);
    expect(startReplay.body.seats.map((seat) => seat.seat).sort()).toEqual([0, 1]);
  });

  it("refunds every held entry, releases the prize and closes the backing tournament/table durably", async () => {
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `cancel-agent-${crypto.randomBytes(3).toString("hex")}`,
      operator.id
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await balanceOf(ctx.app, payer.id, "USER_AVAILABLE");
    const sponsorBefore = await balanceOf(ctx.app, operator.id, "OPERATOR");
    const competition = await createAssetCompetition(operator.token, agent, "Cancel refund");
    const entryReserveKey = `competition-entry:${competition.id}`;
    const prizeReserveKey = `competition-prize:${competition.id}`;

    const optIn = await inject(ctx.app, "POST", `/competitions/${competition.id}/opt-in`, {
      token: payer.token,
    });
    expect(optIn.statusCode).toBe(200);

    const cancelled = await inject<{
      success: boolean;
      status: string;
      cancelledAt: string;
      prizeStatus: string;
      prize: { amountAtomic: string } | null;
      entries: Array<{
        principalId: string;
        entryState: string;
        refunded: boolean;
        refundJournalId: string | null;
      }>;
    }>(ctx.app, "POST", `/competitions/${competition.id}/cancel`, {
      token: operator.token,
    });
    const journalsAfterCancel = await ctx.app.prisma.journalTransaction.count({
      where: { assetId: ASSET_ID },
    });
    expect(cancelled.statusCode, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe("CANCELLED");
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect(cancelled.body.prizeStatus).toBe("RELEASED");
    expect(cancelled.body.prize?.amountAtomic).toBe("5000");
    const payerEntry = cancelled.body.entries.find((entry) => entry.principalId === payer.id)!;
    expect(payerEntry.entryState).toBe("REFUNDED");
    expect(payerEntry.refunded).toBe(true);
    expect(payerEntry.refundJournalId).toBe(
      `competition-entry-refund:${competition.id}:${payer.id}`
    );
    const agentEntry = cancelled.body.entries.find((entry) => entry.principalId === agent)!;
    expect(agentEntry).toMatchObject({ entryState: "NOT_REQUIRED", refunded: false });

    // Exact balances: payer made whole, sponsor made whole, reserves empty.
    expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    expect(await balanceOf(ctx.app, operator.id, "OPERATOR")).toBe(sponsorBefore);
    expect(await balanceOf(ctx.app, null, "TOURNAMENT_RESERVE", entryReserveKey)).toBe(0n);
    expect(await balanceOf(ctx.app, null, "TOURNAMENT_RESERVE", prizeReserveKey)).toBe(0n);

    // Durable close of the backing machinery.
    const row = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: {
        status: true,
        cancelledAt: true,
        tournament: { select: { status: true } },
        entrants: { select: { principalId: true, entryState: true } },
      },
    });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).not.toBeNull();
    expect(row.tournament.status).toBe("CANCELLED");
    const table = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { status: true },
    });
    expect(table.status).toBe("CLOSED");

    // Idempotent replay from durable state: same response, no new journals.
    const replay = await inject<typeof cancelled.body>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/cancel`,
      { token: operator.token }
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(cancelled.body);
    expect(await ctx.app.prisma.journalTransaction.count({ where: { assetId: ASSET_ID } })).toBe(
      journalsAfterCancel
    );

    // The accepted charge receipt stays replayable after cancellation: the
    // live entry state is REFUNDED, no second charge ever happens.
    const lateOptIn = await inject<{ entryState: string; journalRequestId: string }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/opt-in`,
      { token: payer.token }
    );
    expect(lateOptIn.statusCode, JSON.stringify(lateOptIn.body)).toBe(200);
    expect(lateOptIn.body.entryState).toBe("REFUNDED");
    expect(lateOptIn.body.journalRequestId).toBe(
      `competition-entry-reserve:${competition.id}:${payer.id}`
    );
    expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    // Start remains closed on a cancelled competition.
    const lateStart = await inject<{ error?: string }>(
      ctx.app,
      "POST",
      `/competitions/${competition.id}/start`,
      { token: operator.token }
    );
    expect(lateStart.statusCode).toBe(409);

    // Cancellation is risk-reducing: it succeeds even while paid admission is
    // disabled and readiness is BLOCKED.
    const second = await createAssetCompetition(operator.token, agent, "Degraded cancel");
    const secondOptIn = await inject(ctx.app, "POST", `/competitions/${second.id}/opt-in`, {
      token: payer.token,
    });
    expect(secondOptIn.statusCode).toBe(200);
    paidFlag.enabled = false;
    vi.spyOn(ctx.app.platformReadiness, "evaluate").mockResolvedValue({
      financial: { state: "BLOCKED", reasons: ["ASSET_LEDGER_UNVERIFIED"], checks: [] },
    } as never);
    try {
      const degraded = await inject<{ status: string }>(
        ctx.app,
        "POST",
        `/competitions/${second.id}/cancel`,
        { token: operator.token }
      );
      expect(degraded.statusCode, JSON.stringify(degraded.body)).toBe(200);
      expect(degraded.body.status).toBe("CANCELLED");
      expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    } finally {
      paidFlag.enabled = true;
      vi.restoreAllMocks();
      vi.spyOn(ctx.app.platformReadiness, "evaluate").mockResolvedValue({
        financial: { state: "READY", reasons: [], checks: [] },
      } as never);
    }
  });

  it("refuses malformed entry evidence without moving value or cancelling", async () => {
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `cancel-agent-${crypto.randomBytes(3).toString("hex")}`,
      operator.id
    );
    servicePrincipalIds.push(agent);

    const sponsorBefore = await balanceOf(ctx.app, operator.id, "OPERATOR");
    const competition = await createAssetCompetition(operator.token, agent, "Malformed evidence");

    // Declared fixture: a PAID entry whose journal credits the sponsor's
    // OPERATOR account instead of the competition entry reserve. It is not a
    // canonical reserve credit and must be refused, never accepted as evidence.
    const ledger = new AtomicLedger(ctx.app.prisma);
    const from = await ledger.ensureAccount(ctx.app.prisma, {
      assetId: ASSET_ID,
      ownerId: payer.id,
      class: "USER_AVAILABLE",
    });
    const to = await ledger.ensureAccount(ctx.app.prisma, {
      assetId: ASSET_ID,
      ownerId: operator.id,
      class: "OPERATOR",
    });
    const foreignRequestId = `competition-entry:${competition.id}:${payer.id}`;
    await ledger.postAtomic({
      requestId: foreignRequestId,
      assetId: ASSET_ID,
      postings: [
        { accountId: from.accountId, amountAtomic: "-1000" },
        { accountId: to.accountId, amountAtomic: "1000" },
      ],
    });
    await ctx.app.prisma.competitionEntrant.update({
      where: {
        competitionId_principalId: { competitionId: competition.id, principalId: payer.id },
      },
      data: { entryState: "PAID", entryJournalId: foreignRequestId },
    });

    // All-or-nothing: the whole cancellation is refused and the competition
    // stays REGISTRATION with the prize still reserved and no refund journal.
    for (const path of ["cancel", "start"] as const) {
      const blocked = await inject<{ error?: string }>(
        ctx.app,
        "POST",
        `/competitions/${competition.id}/${path}`,
        { token: operator.token }
      );
      expect(blocked.statusCode, `${path}: ${JSON.stringify(blocked.body)}`).toBe(409);
      expect(blocked.body.error).toBe("COMPETITION_ENTRY_UNRESOLVED");
    }
    const unchanged = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, cancelledAt: true, startedAt: true },
    });
    expect(unchanged.status).toBe("REGISTRATION");
    expect(unchanged.cancelledAt).toBeNull();
    expect(unchanged.startedAt).toBeNull();
    expect(
      await ctx.app.prisma.journalTransaction.count({
        where: { requestId: `competition-entry-refund:${competition.id}:${payer.id}` },
      })
    ).toBe(0);
    expect(
      await ctx.app.prisma.journalTransaction.count({
        where: { requestId: `competition-entry-release:${competition.id}:${payer.id}` },
      })
    ).toBe(0);
    expect(await balanceOf(ctx.app, operator.id, "OPERATOR")).toBe(sponsorBefore - 5000n + 1000n);
    expect(
      await balanceOf(ctx.app, null, "TOURNAMENT_RESERVE", `competition-prize:${competition.id}`)
    ).toBe(5000n);

    // Remove the declared malformed fixture so it cannot leak into later tests.
    await ctx.app.prisma.competition.delete({ where: { id: competition.id } });
  });

  it("sanitizes unexpected driver errors on the competition surface", async () => {
    const spy = vi.spyOn(ctx.app.prisma.competition, "findUnique").mockRejectedValueOnce(
      Object.assign(new Error("postgres://user:credential-secret@host/db"), {
        code: "P2028",
        statusCode: 500,
      })
    );
    try {
      const response = await inject<{ error?: string; message?: string }>(
        ctx.app,
        "GET",
        "/competitions/does-not-exist",
        { token: payer.token }
      );
      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({
        error: "INTERNAL_ERROR",
        message: "Internal server error",
      });
      expect(JSON.stringify(response.body)).not.toContain("credential-secret");
    } finally {
      spy.mockRestore();
    }
  });

  it("serializes concurrent start and cancel so exactly one wins", async () => {
    const agent = await provisionServicePrincipal(
      ctx.app,
      operator.token,
      `cancel-agent-${crypto.randomBytes(3).toString("hex")}`,
      operator.id
    );
    servicePrincipalIds.push(agent);

    const payerBefore = await balanceOf(ctx.app, payer.id, "USER_AVAILABLE");
    const competition = await createAssetCompetition(operator.token, agent, "Start cancel race");
    const optIn = await inject(ctx.app, "POST", `/competitions/${competition.id}/opt-in`, {
      token: payer.token,
    });
    expect(optIn.statusCode).toBe(200);

    const [startResponse, cancelResponse] = await Promise.all([
      inject<{ error?: string }>(ctx.app, "POST", `/competitions/${competition.id}/start`, {
        token: operator.token,
      }),
      inject<{ error?: string }>(ctx.app, "POST", `/competitions/${competition.id}/cancel`, {
        token: operator.token,
      }),
    ]);
    const statuses = [startResponse.statusCode, cancelResponse.statusCode].sort();
    expect(statuses, JSON.stringify([startResponse.body, cancelResponse.body])).toEqual([200, 409]);

    const row = await ctx.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true, cancelledAt: true },
    });
    if (row.status === "RUNNING") {
      // Start won: cancel lost, the entry was transferred to the sponsor.
      expect(row.startedAt).not.toBeNull();
      expect(cancelResponse.statusCode).toBe(409);
      expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore - 1000n);
    } else {
      // Cancel won: start lost, the entry was refunded exactly.
      expect(row.status).toBe("CANCELLED");
      expect(row.cancelledAt).not.toBeNull();
      expect(startResponse.statusCode).toBe(409);
      expect(await balanceOf(ctx.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    }
  });
});
