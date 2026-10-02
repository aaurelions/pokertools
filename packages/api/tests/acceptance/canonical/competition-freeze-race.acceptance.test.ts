/**
 * Adversarial PostgreSQL regression: paid admission must not admit value while
 * an asset freezes between a plain ACTIVE read and the ledger's per-asset write
 * lock (TOCTOU).
 *
 * The freeze is committed deterministically on a separate connection from a
 * spy around `AtomicLedger.lockAsset` — the exact window the tester reported —
 * with no sleeps. Admission (prize reservation, entry charge, start) must fail
 * closed and leave no journal, no PAID marker and no RUNNING competition.
 *
 * Real readiness evidence (reconciliation + custody heartbeat) is seeded as in
 * the happy-path acceptance suite; the chain-quorum probe is the only seam.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";
import { AtomicLedger } from "../../../src/services/atomic-ledger.js";

const ASSET_ID = "eip155:31337/erc20:0x5555555555555555555555555555555555555555";
const TOKEN_ADDRESS = "0x5555555555555555555555555555555555555555";
const TREASURY = "0x6666666666666666666666666666666666666666";

interface CompetitionWire {
  id: string;
  tableId: string;
}

function createAsset(app: FastifyInstance): Promise<unknown> {
  return app.prisma.asset.upsert({
    where: { id: ASSET_ID },
    update: { status: "ACTIVE" },
    create: {
      id: ASSET_ID,
      chainId: 31337,
      tokenAddress: TOKEN_ADDRESS,
      symbol: "FRZ",
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
      evidence: { source: "competition-freeze-acceptance" },
    },
  });
  await app.prisma.custodyHeartbeat.create({
    data: {
      chainId: 31337,
      signerAddress: TREASURY,
      signerReady: true,
      gasReady: true,
      workerId: "competition-freeze-worker",
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
    requestId: `freeze-fixture-fund:${label}`,
    assetId: ASSET_ID,
    postings: [
      { accountId: from.accountId, amountAtomic: `-${amountAtomic}` },
      { accountId: to.accountId, amountAtomic },
    ],
  });
}

async function atomicBalance(
  app: FastifyInstance,
  ownerId: string,
  accountClass: "USER_AVAILABLE" | "OPERATOR"
): Promise<bigint> {
  const account = await app.prisma.atomicAccount.findFirst({
    where: { assetId: ASSET_ID, class: accountClass, ownerId },
  });
  return account ? BigInt(account.balanceAtomic) : 0n;
}

async function createOrchestrator(
  baseUrl: string,
  operatorToken: string
): Promise<{ principalId: string }> {
  const response = await apiRequest<{ userId: string }>(
    baseUrl,
    "POST",
    "/auth/service-credentials",
    {
      token: operatorToken,
      body: {
        name: `freeze-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return { principalId: response.body.userId };
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

describe("competition paid admission freeze race (PostgreSQL + Redis)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  let payer: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    booted = await bootApp({
      readiness: {
        chainQuorum: {
          async verifyQuorum() {
            return { ok: true as const, code: "RPC_QUORUM_OK", chainsChecked: 1 };
          },
        },
      },
    });
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
    // Readiness evidence is retained: the shared suite's ledger/asset probes
    // evaluate every ACTIVE asset, so removing this asset's reconciliation or
    // heartbeat would make later files' financial readiness fail closed.
    await booted.close();
  });

  it("rejects paid admission when the asset freezes between the ACTIVE read and the ledger lock", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `freeze-agent-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const terms = (payerId: string) => ({
      entry: { assetId: ASSET_ID, amountAtomic: "1000", payers: [{ principalId: payerId }] },
      prize: { assetId: ASSET_ID, amountAtomic: "5000", sponsorPrincipalId: operator.id },
    });

    /**
     * Deterministic freeze race: commit FROZEN on a separate connection just
     * before the ledger's per-asset write lock, i.e. after any plain ACTIVE
     * pre-read. No sleeps.
     */
    const freezeOnNextLedgerLock = async <T>(run: () => Promise<T>): Promise<T> => {
      const originalLock = AtomicLedger.prototype.lockAsset;
      let frozen = false;
      const spy = vi.spyOn(AtomicLedger.prototype, "lockAsset").mockImplementation(async function (
        this: AtomicLedger,
        client,
        assetId: string
      ): Promise<boolean> {
        if (!frozen) {
          frozen = true;
          await booted.app.prisma.asset.update({
            where: { id: assetId },
            data: { status: "FROZEN" },
          });
        }
        return originalLock.call(this, client, assetId);
      });
      try {
        return await run();
      } finally {
        spy.mockRestore();
      }
    };

    // 1. Create (prize reservation) must fail closed with no orphan rows.
    const tablesBefore = await booted.app.prisma.table.count();
    const competitionsBefore = await booted.app.prisma.competition.count();
    const reservationsBefore = await booted.app.prisma.journalTransaction.count({
      where: { requestId: { startsWith: "competition-prize-reserve:" } },
    });
    const createBlocked = await freezeOnNextLedgerLock(() =>
      apiRequest<{ error?: string }>(booted.baseUrl, "POST", "/competitions", {
        token: operator.token,
        body: {
          name: "Freeze create",
          mode: "ASSET",
          entrants: [
            { principalId: payer.id, kind: "WALLET" },
            { principalId: agent, kind: "SERVICE" },
          ],
          smallBlind: 100,
          bigBlind: 200,
          terms: terms(payer.id),
          idempotencyKey: crypto.randomUUID(),
        },
      })
    );
    expect(createBlocked.status, JSON.stringify(createBlocked.body)).toBe(409);
    expect(createBlocked.body.error).toBe("COMPETITION_ASSET_NOT_ACTIVE");
    expect(await booted.app.prisma.table.count()).toBe(tablesBefore);
    expect(await booted.app.prisma.competition.count()).toBe(competitionsBefore);
    expect(
      await booted.app.prisma.journalTransaction.count({
        where: { requestId: { startsWith: "competition-prize-reserve:" } },
      })
    ).toBe(reservationsBefore);
    await booted.app.prisma.asset.update({ where: { id: ASSET_ID }, data: { status: "ACTIVE" } });

    // 2. Opt-in (entry charge) must fail closed with no journal and no PAID.
    const created = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "POST",
      "/competitions",
      {
        token: operator.token,
        body: {
          name: "Freeze opt-in",
          mode: "ASSET",
          entrants: [
            { principalId: payer.id, kind: "WALLET" },
            { principalId: agent, kind: "SERVICE" },
          ],
          smallBlind: 100,
          bigBlind: 200,
          terms: terms(payer.id),
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);
    const payerBefore = await atomicBalance(booted.app, payer.id, "USER_AVAILABLE");

    const optInBlocked = await freezeOnNextLedgerLock(() =>
      apiRequest<{ error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/opt-in`,
        { token: payer.token, body: { idempotencyKey: crypto.randomUUID() } }
      )
    );
    expect(optInBlocked.status, JSON.stringify(optInBlocked.body)).toBe(409);
    expect(optInBlocked.body.error).toBe("COMPETITION_ASSET_NOT_ACTIVE");
    expect(
      await booted.app.prisma.journalTransaction.findUnique({
        where: { requestId: `competition-entry:${competition.id}:${payer.id}` },
      })
    ).toBeNull();
    expect(await atomicBalance(booted.app, payer.id, "USER_AVAILABLE")).toBe(payerBefore);
    expect(
      (
        await booted.app.prisma.competitionEntrant.findFirstOrThrow({
          where: { competitionId: competition.id, principalId: payer.id },
          select: { entryState: true },
        })
      ).entryState
    ).toBe("PENDING");
    await booted.app.prisma.asset.update({ where: { id: ASSET_ID }, data: { status: "ACTIVE" } });

    // 3. Start must fail closed and leave the competition REGISTRATION.
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
    const startBlocked = await freezeOnNextLedgerLock(() =>
      apiRequest<{ error?: string }>(
        booted.baseUrl,
        "POST",
        `/competitions/${competition.id}/start`,
        {
          token: operator.token,
          body: { idempotencyKey: crypto.randomUUID() },
        }
      )
    );
    expect(startBlocked.status, JSON.stringify(startBlocked.body)).toBe(409);
    expect(startBlocked.body.error).toBe("COMPETITION_ASSET_NOT_ACTIVE");
    const after = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { status: true, startedAt: true, tournament: { select: { status: true } } },
    });
    expect(after.status).toBe("REGISTRATION");
    expect(after.startedAt).toBeNull();
    expect(after.tournament.status).toBe("REGISTRATION");
    await booted.app.prisma.asset.update({ where: { id: ASSET_ID }, data: { status: "ACTIVE" } });
  });
});
