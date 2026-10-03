/**
 * Competition ASSET finance acceptance against the REAL Fastify app, the fresh
 * PostgreSQL/Redis pair and live Anvil (the existing finance acceptance harness).
 *
 * What this file proves, end to end and without shortcuts:
 *
 * 1. Real funding: the entry payer and the prize sponsor receive their ledger
 *    balances ONLY from real on-chain ERC-20 transfers claimed through the
 *    public `PokerClient.claimDeposit` path (exact `(txHash, logIndex)`).
 * 2. Central readiness: paid ASSET admission stays 503 until the ACTUAL custody
 *    worker writes durable heartbeats and a matched treasury reconciliation over
 *    real quorum RPC reads; no seeded READY row and no test quorum seam exists
 *    here. The readiness negative is asserted before the worker starts.
 * 3. Sponsor budget: the sponsor's OPERATOR account (the prize-reserve source)
 *    is funded by one declared, balanced, idempotent
 *    `USER_AVAILABLE -> OPERATOR` classification journal. It creates no value
 *    (both legs are real ledger postings, the principal's total is unchanged)
 *    and is the only way a WALLET principal can become the authorized sponsor.
 * 4. Lifecycle semantics of the canonical competition surface (create keeps its
 *    real `idempotencyKey`; opt-in/start/settle/cancel are strict empty-body,
 *    naturally idempotent operations):
 *    - create reserves the sponsor prize and assigns CSPRNG-random seats that
 *      this test resolves from the projection instead of assuming roster order;
 *    - opt-in charges the configured WALLET payer exactly once into the
 *      competition entry reserve (a retry replays the same journal);
 *    - start releases the held entry to the sponsor exactly once and seats every
 *      entrant at its authoritative seat;
 *    - gameplay is real canonical HTTP/SDK play (observations + canonical action
 *      submissions over a listening API socket), not DB mutation;
 *    - settle disposes the reserved prize exactly once: PAID to a WALLET winner,
 *      RELEASED to the sponsor when the winner is SERVICE;
 *    - a durable crash/restart between the backing tournament settlement and
 *      the competition disposition is reproduced through the public tournament
 *      settle route, then the API process is closed and rebooted; the competition
 *      settle then completes the single disposition from durable state only,
 *      under concurrent settle retries;
 *    - cancellation refunds the held entry to the payer and releases the prize
 *      to the sponsor exactly once, under concurrent cancel retries.
 * 5. Per-asset journals are asserted balanced (`AtomicLedger.assertAssetBalanced`)
 *    and every competition reserve account is empty after disposition; the only
 *    journal requestIds for the asset are the real deposit credits, the declared
 *    classification fixture and the canonical competition lifecycle identities.
 *
 * No balance is ever granted directly: no DB credit shortcut, no fake readiness,
 * no injected quorum, no test-only route.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseEther, type Address } from "viem";
import type { HDAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type {
  CancelCompetitionResponse,
  Competition,
  LegalAction,
  ReadinessResponse,
  SettleCompetitionResponse,
} from "@pokertools/types";
import { AtomicLedger } from "../../../api/src/services/atomic-ledger.js";
import { createAssetBackedCustodyQuorumReader } from "../../../api/src/finance-core.js";
import { createPrismaClient } from "../../../api/src/utils/prisma-client.js";
import { staticAccountResolver } from "../../../custody/src/core/viem-ports.js";
import { CustodyHeartbeatWriter } from "../../../custody/src/workers/heartbeat-writer.js";
import { CustodyWorker } from "../../../custody/src/workers/custody-worker.js";
import { CompetitionClient, PokerClient } from "@pokertools/sdk";
import {
  ANVIL_ACCOUNT_ZERO_KEY,
  attachTwoChainAnvil,
  CHAIN_A_ID,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  transferToken,
  type DeployedToken,
  type LocalChain,
} from "./helpers/anvil-two-chain.js";
import { startQuorumProxies, type ProxySet } from "./helpers/quorum-proxy.js";
import { flushRedis, resetPostgresSchema } from "./helpers/fresh-infra.js";
import { createAssetFixture, resolveAllOpenIncidents } from "./helpers/finance-fixtures.js";
import {
  bootFinanceApi,
  closeFinanceApi,
  configureFinanceApiEnv,
} from "./helpers/finance-api-harness.js";
import { buildCustodyHarness, type CustodyHarness } from "./helpers/custody-harness.js";
import { requireInfra, type Handoff } from "./helpers/infra.js";

const TREASURY_INDEX = 0;
const PAYER_INDEX = 11;
const SPONSOR_INDEX = 12;
const OPPONENT_INDEX = 13;
const TREASURY = getAccount(TREASURY_INDEX).address.toLowerCase() as Address;
const TREASURY_KEY = ANVIL_ACCOUNT_ZERO_KEY;

const ENTRY_ATOMIC = 5_000_000n; // 5.000000 USDC
const PRIZE_ATOMIC = 20_000_000n; // 20.000000 USDC
const PAYER_CLAIM_ATOMIC = 100_000_000n;
const SPONSOR_CLAIM_ATOMIC = 100_000_000n;
/** Three competitions each reserve one prize (wallet / service / cancel). */
const SPONSOR_BUDGET_ATOMIC = PRIZE_ATOMIC * 3n;
const CLASSIFY_REQUEST_ID = `acceptance-sponsor-budget:${CHAIN_A_ID}:${SPONSOR_INDEX}`;

const QUIET_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Ledger journal requestId prefixes this asset may legitimately contain. */
const ALLOWED_JOURNAL_PREFIXES = [
  "deposit:",
  "acceptance-sponsor-budget:",
  "competition-entry-reserve:",
  "competition-entry-release:",
  "competition-entry-refund:",
  "competition-prize-reserve:",
  "competition-prize-settlement:",
];

interface SdkSession {
  account: HDAccount;
  client: PokerClient;
  token: string;
  principalId: string;
  address: Address;
}

interface GameplaySession {
  principalId: string;
  client: PokerClient;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** viem caches block height for its polling interval; let it expire. */
const settle = () => sleep(4_300);

describe("competition ASSET acceptance (real API + fresh PostgreSQL/Redis + live Anvil)", () => {
  let infra: Handoff;
  let chain: LocalChain;
  let token: DeployedToken;
  let proxies: ProxySet;
  let prisma: ReturnType<typeof createPrismaClient>;
  let ledger: AtomicLedger;
  let app: FastifyInstance;
  let baseUrl: string;
  let assetId: string;

  let harness: CustodyHarness;
  let custodyWorker: CustodyWorker;

  let payer: SdkSession;
  let sponsor: SdkSession;
  let opponent: SdkSession;

  async function bootListeningApp(): Promise<void> {
    app = await bootFinanceApi(infra);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("API did not expose a TCP address for SDK gameplay");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  /** Real SIWE sign-in through the public SDK over the listening HTTP socket. */
  async function sdkLogin(account: HDAccount, base: string): Promise<SdkSession> {
    const client = new PokerClient({
      baseUrl: base,
      timeout: 15_000,
      retry: { count: 2, delay: 100, backoff: 2 },
    });
    const nonce = await client.getNonce();
    const origin = new URL(base);
    const message = createSiweMessage({
      address: account.address,
      chainId: CHAIN_A_ID,
      domain: origin.hostname,
      nonce,
      uri: base,
      version: "1",
    });
    const signature = await account.signMessage({ message });
    const login = await client.login({ message, signature });
    return {
      account,
      client,
      token: login.token,
      principalId: login.user.id,
      address: account.address.toLowerCase() as Address,
    };
  }

  function pokerClient(session: SdkSession, base = baseUrl): PokerClient {
    return new PokerClient({
      baseUrl: base,
      token: session.token,
      timeout: 20_000,
      retry: { count: 2, delay: 100, backoff: 2 },
    });
  }

  function competitionClient(session: SdkSession, base = baseUrl): CompetitionClient {
    return new CompetitionClient({
      baseUrl: base,
      token: session.token,
      timeout: 30_000,
      retry: { count: 2, delay: 100, backoff: 2 },
    });
  }

  async function readiness(base = baseUrl): Promise<ReadinessResponse> {
    return new PokerClient({ baseUrl: base, timeout: 15_000 }).getReadiness();
  }

  async function waitForFinancialReady(timeoutMs = 120_000): Promise<ReadinessResponse> {
    const deadline = Date.now() + timeoutMs;
    let last: ReadinessResponse | null = null;
    while (Date.now() < deadline) {
      last = await readiness();
      if (last.financial.state === "READY") return last;
      await sleep(1_000);
    }
    throw new Error(
      `platform financial readiness never reached READY: ${JSON.stringify(last?.financial)}`
    );
  }

  /**
   * Real on-chain transfer to the treasury, then a public exact-log deposit
   * claim. This is the ONLY way a principal obtains a ledger balance here.
   */
  async function fundAndClaim(
    session: SdkSession,
    accountIndex: number,
    amountAtomic: bigint
  ): Promise<void> {
    await mintToken(chain, token.address, session.address, amountAtomic);
    const receipt = await transferToken(chain, token.address, accountIndex, TREASURY, amountAtomic);
    const [log] = findTransferLogs(receipt, token.address, {
      from: session.address,
      to: TREASURY,
      value: amountAtomic,
    });
    if (!log) throw new Error("on-chain transfer produced no exact Transfer log");
    await mine(chain, 3);
    await settle();
    const claim = await session.client.claimDeposit({
      assetId,
      txHash: log.txHash,
      logIndex: log.logIndex,
    });
    expect(claim.amountAtomic).toBe(amountAtomic.toString());
  }

  /**
   * Declared infrastructure fixture ONLY (documented, never a balance credit):
   * one balanced, idempotent `USER_AVAILABLE -> OPERATOR` classification of
   * already-claimed sponsor funds. The prize reserve debits the sponsor's
   * OPERATOR account while a public deposit credits USER_AVAILABLE; both legs
   * are real journal postings that sum to zero, so the principal's total and the
   * on-chain backing are unchanged.
   */
  async function classifySponsorBudget(): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const from = await ledger.ensureAccount(tx, {
        assetId,
        ownerId: sponsor.principalId,
        class: "USER_AVAILABLE",
      });
      const to = await ledger.ensureAccount(tx, {
        assetId,
        ownerId: sponsor.principalId,
        class: "OPERATOR",
      });
      await ledger.post(tx, {
        requestId: CLASSIFY_REQUEST_ID,
        assetId,
        postings: [
          { accountId: from.accountId, amountAtomic: (-SPONSOR_BUDGET_ATOMIC).toString() },
          { accountId: to.accountId, amountAtomic: SPONSOR_BUDGET_ATOMIC.toString() },
        ],
      });
    });
  }

  async function balanceOf(ownerId: string | null, accountClass: string): Promise<bigint> {
    const account = await ledger.getAccount(prisma, {
      assetId,
      ownerId,
      class: accountClass as never,
    });
    return account ? BigInt(account.balanceAtomic) : 0n;
  }

  const entryReserveOwner = (competitionId: string) => `competition-entry:${competitionId}`;
  const prizeReserveOwner = (competitionId: string) => `competition-prize:${competitionId}`;

  async function entryReserve(competitionId: string): Promise<bigint> {
    return balanceOf(entryReserveOwner(competitionId), "TOURNAMENT_RESERVE");
  }

  async function prizeReserve(competitionId: string): Promise<bigint> {
    return balanceOf(prizeReserveOwner(competitionId), "TOURNAMENT_RESERVE");
  }

  async function journalCount(requestId: string): Promise<number> {
    return prisma.journalTransaction.count({ where: { requestId } });
  }

  function entrantOf(competition: Competition, principalId: string) {
    const entrant = competition.entrants.find((entry) => entry.principalId === principalId);
    if (!entrant) throw new Error(`principal ${principalId} is not a competition entrant`);
    return entrant;
  }

  function assertSeatsAreAssigned(competition: Competition): void {
    const seats = competition.entrants.map((entrant) => entrant.seat).sort((a, b) => a - b);
    const expected = competition.entrants.map((_, index) => index);
    expect(seats).toEqual(expected);
  }

  async function assetJournalRequestIds(): Promise<string[]> {
    const rows = await prisma.journalTransaction.findMany({
      where: { assetId },
      select: { requestId: true },
    });
    return rows.map((row) => row.requestId).sort();
  }

  async function assertAssetSettledBalanced(): Promise<void> {
    await expect(ledger.assertAssetBalanced(prisma, assetId)).resolves.toBeDefined();
  }

  /** Tolerate only documented optimistic-concurrency races during play. */
  function isIgnorableRace(error: unknown): boolean {
    const record = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    const code = typeof record?.code === "string" ? record.code : "";
    const message = typeof record?.message === "string" ? record.message : "";
    const status = typeof record?.statusCode === "number" ? record.statusCode : null;
    if (code === "TIMEOUT" || code === "NOT_MODIFIED") return true;
    if (
      /(stale|superseded|conflict|turn|version|illegal|obsolete|expired|not open for play|NOT_ACTIONABLE|TABLE_CLOSED)/i.test(
        `${code} ${message}`
      )
    ) {
      return true;
    }
    return status === 404 || status === 409;
  }

  function chooseLegalAction(
    isFolder: boolean,
    legalActions: readonly LegalAction[]
  ): LegalAction | undefined {
    const order = isFolder
      ? ["FOLD", "MUCK", "CHECK", "CALL", "DEAL", "SHOW"]
      : ["RAISE", "BET", "DEAL", "SHOW", "CHECK", "CALL", "MUCK", "FOLD"];
    for (const family of order) {
      const found = legalActions.find((action) => action.family === family);
      if (found) return found;
    }
    return legalActions[0];
  }

  async function submitLegalAction(
    session: GameplaySession,
    tableId: string,
    action: LegalAction,
    turnId: string,
    version: number
  ): Promise<boolean> {
    const amount =
      action.family === "BET" || action.family === "RAISE"
        ? (action.maxAmount ?? action.amount ?? action.minAmount)
        : action.amount;
    try {
      await session.client.action(tableId, {
        requestId: randomUUID(),
        turnId,
        expectedVersion: version,
        actionId: action.actionId,
        ...(amount !== undefined && amount > 0 ? { amount } : {}),
      });
      return true;
    } catch (error) {
      if (isIgnorableRace(error)) return false;
      throw error;
    }
  }

  /**
   * Real canonical HTTP/SDK gameplay: poll the authoritative per-seat
   * observation and submit the server-issued legal action over the SDK. The
   * designated folder folds whenever it can; the winner raises the server-issued
   * maximum (or checks/calls). The hand is dealt through the SDK DEAL family
   * after each completed hand. Returns the number of accepted actions.
   */
  async function playToBust(input: {
    tableId: string;
    winner: GameplaySession;
    folder: GameplaySession;
    maxDeals?: number;
  }): Promise<{ actions: number; deals: number }> {
    const maxDeals = input.maxDeals ?? 400;
    let actions = 0;
    let deals = 0;
    const deadline = Date.now() + 180_000;
    while (true) {
      if (Date.now() > deadline) throw new Error("gameplay deadline exceeded");
      if (deals > maxDeals) {
        throw new Error(`gameplay exceeded ${maxDeals} deals without a bust`);
      }
      for (const session of [input.winner, input.folder]) {
        const observation = await session.client.getObservation(input.tableId);
        if (observation.legalActions.length === 0) continue;
        const action = chooseLegalAction(
          session.principalId === input.folder.principalId,
          observation.legalActions
        );
        if (!action) continue;
        const accepted = await submitLegalAction(
          session,
          input.tableId,
          action,
          observation.turnId,
          observation.version
        );
        if (!accepted) continue;
        actions += 1;
        if (action.family === "DEAL") deals += 1;
      }
      const state = await input.winner.client.getTableState(input.tableId);
      if (state && state.winners && state.winners.length > 0 && state.actionTo === null) {
        const live = state.players.filter(
          (player): player is NonNullable<typeof player> => player !== null && player.stack > 0
        );
        if (live.length <= 1) return { actions, deals };
      }
      await sleep(30);
    }
  }

  function liveWinnerFromState(
    state: NonNullable<Awaited<ReturnType<PokerClient["getTableState"]>>>
  ): string | null {
    const live = state.players.filter(
      (player): player is NonNullable<typeof player> => player !== null && player.stack > 0
    );
    return live.length === 1 ? live[0].id : null;
  }

  beforeAll(async () => {
    infra = requireInfra();
    configureFinanceApiEnv({ databaseUrl: infra.databaseUrl, redisUrl: infra.redisUrl });

    // Cross-file isolation: the shared disposable database must contain only
    // this file's asset before readiness is evaluated, because central
    // readiness verifies EVERY configured asset and its custody heartbeat.
    await resetPostgresSchema(infra.databaseUrl);
    await flushRedis(infra.redisUrl);

    ({ chainA: chain } = await attachTwoChainAnvil());
    token = await deployMockUsdc6(chain);
    assetId = `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`;
    proxies = await startQuorumProxies(chain.rpcUrl, 2);

    prisma = createPrismaClient();
    ledger = new AtomicLedger(prisma);
    await resolveAllOpenIncidents(prisma);
    await createAssetFixture(prisma, {
      assetId,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address,
      symbol: token.symbol,
      decimals: 6,
      treasuryAddress: TREASURY,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      confirmations: 1,
      deepFinality: 3,
      minGasAtomic: parseEther("0.1").toString(),
    });

    await bootListeningApp();
    payer = await sdkLogin(getAccount(PAYER_INDEX), baseUrl);
    sponsor = await sdkLogin(getAccount(SPONSOR_INDEX), baseUrl);
    opponent = await sdkLogin(getAccount(OPPONENT_INDEX), baseUrl);
    // Operator role is an auth fixture, not a balance credit: the session reads
    // the live role from the database on every request.
    await prisma.user.update({ where: { id: sponsor.principalId }, data: { role: "ADMIN" } });

    // Real funding claims: no ledger credit exists before these.
    await fundAndClaim(payer, PAYER_INDEX, PAYER_CLAIM_ATOMIC);
    await fundAndClaim(sponsor, SPONSOR_INDEX, SPONSOR_CLAIM_ATOMIC);
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(PAYER_CLAIM_ATOMIC);
    expect(await balanceOf(sponsor.principalId, "USER_AVAILABLE")).toBe(SPONSOR_CLAIM_ATOMIC);

    const totalBeforeClassification =
      (await balanceOf(sponsor.principalId, "USER_AVAILABLE")) +
      (await balanceOf(sponsor.principalId, "OPERATOR"));
    await classifySponsorBudget();
    expect(
      (await balanceOf(sponsor.principalId, "USER_AVAILABLE")) +
        (await balanceOf(sponsor.principalId, "OPERATOR"))
    ).toBe(totalBeforeClassification);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(SPONSOR_BUDGET_ATOMIC);
    expect(await journalCount(CLASSIFY_REQUEST_ID)).toBe(1);
  }, 300_000);

  afterAll(async () => {
    custodyWorker?.stop();
    await prisma?.asset
      .update({ where: { id: assetId }, data: { status: "FROZEN" } })
      .catch(() => undefined);
    await resolveAllOpenIncidents(prisma);
    await closeFinanceApi();
    await proxies?.close();
    await prisma?.$disconnect();
  });

  it("requires real custody heartbeat/reconciliation evidence before paid admission is READY", async () => {
    // The API is already running against the funded asset, but the custody
    // worker has not produced a single heartbeat or reconciliation yet.
    const before = await readiness();
    expect(before.financial.state).not.toBe("READY");
    expect(before.financial.reasons).toContain("CUSTODY_WORKFLOW_UNVERIFIED");
    expect(before.financial.reasons).toContain("RECONCILIATION_UNVERIFIED");

    // Paid ASSET admission fails closed on the real readiness gate.
    const competitions = competitionClient(sponsor);
    await expect(
      competitions.createCompetition({
        name: `accept-not-ready-${randomUUID().slice(0, 8)}`,
        mode: "ASSET",
        entrants: [
          { principalId: payer.principalId, kind: "WALLET" },
          { principalId: opponent.principalId, kind: "WALLET" },
        ],
        terms: {
          entry: {
            assetId,
            amountAtomic: ENTRY_ATOMIC.toString(),
            payers: [{ principalId: payer.principalId }],
          },
          prize: {
            assetId,
            amountAtomic: PRIZE_ATOMIC.toString(),
            sponsorPrincipalId: sponsor.principalId,
          },
        },
        idempotencyKey: `accept-not-ready:${randomUUID()}`,
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "COMPETITION_FINANCIAL_NOT_READY",
    });

    // Start the ACTUAL custody worker: it produces durable heartbeats and
    // matched reconciliation from real quorum RPC reads. No seeded READY.
    harness = buildCustodyHarness({
      prisma,
      databaseUrl: infra.databaseUrl,
      chainId: CHAIN_A_ID,
      rpcUrls: proxies.proxies.map((proxy) => proxy.url),
      tokenAddress: token.address,
      treasuryAddress: TREASURY,
      treasuryPrivateKey: TREASURY_KEY,
      confirmations: 1,
      deepFinality: 3,
      quorumThreshold: 2,
      minQuorum: 2,
    });
    const heartbeats = new CustodyHeartbeatWriter({
      prisma,
      assets: harness.assets,
      quorum: createAssetBackedCustodyQuorumReader(prisma, { quorum: 2, minFanout: 2 }),
      accounts: staticAccountResolver(new Map([[CHAIN_A_ID, TREASURY_KEY]])),
      workerId: "finance-acceptance-competition",
      clock: { now: () => Date.now() },
      logger: QUIET_LOGGER,
    });
    custodyWorker = new CustodyWorker(
      harness.workflow,
      harness.assets,
      QUIET_LOGGER,
      { intervalMs: 1_000, reconcileIntervalMs: 2_000 },
      heartbeats
    );
    custodyWorker.start();

    const after = await waitForFinancialReady();
    expect(after.status).toBe("ready");
    const reconciliation = await prisma.treasuryReconciliation.findFirst({
      where: { assetId },
      orderBy: { createdAt: "desc" },
    });
    expect(reconciliation?.status).toBe("MATCHED");
    expect(reconciliation?.differenceAtomic).toBe("0");
    expect(reconciliation?.blockNumber).not.toBeNull();
    const heartbeat = await prisma.custodyHeartbeat.findFirst({
      where: { chainId: CHAIN_A_ID, signerAddress: TREASURY },
      orderBy: { observedAt: "desc" },
    });
    expect(heartbeat?.signerReady).toBe(true);
    expect(heartbeat?.gasReady).toBe(true);
  }, 300_000);

  it("pays a WALLET winner exactly once across a durable restart between tournament and competition disposition", async () => {
    const competitions = competitionClient(sponsor);
    const payerCompetitions = competitionClient(payer);

    const operatorBefore = await balanceOf(sponsor.principalId, "OPERATOR");
    const walletCreateRequest = {
      name: `accept-wallet-${randomUUID().slice(0, 8)}`,
      mode: "ASSET" as const,
      entrants: [
        { principalId: payer.principalId, kind: "WALLET" as const },
        { principalId: opponent.principalId, kind: "WALLET" as const },
      ],
      startingStack: 60,
      smallBlind: 10,
      bigBlind: 20,
      terms: {
        entry: {
          assetId,
          amountAtomic: ENTRY_ATOMIC.toString(),
          payers: [{ principalId: payer.principalId }],
        },
        prize: {
          assetId,
          amountAtomic: PRIZE_ATOMIC.toString(),
          sponsorPrincipalId: sponsor.principalId,
        },
      },
      idempotencyKey: `accept-wallet:${randomUUID()}`,
    };
    const created = await competitions.createCompetition(walletCreateRequest);
    const competitionId = created.competition.id;
    expect(created.replayed).toBe(false);
    expect(created.competition.mode).toBe("ASSET");
    expect(created.competition.prizeStatus).toBe("RESERVED");
    // Seats are server-assigned CSPRNG values; resolve them, never assume.
    assertSeatsAreAssigned(created.competition);
    const payerSeat = entrantOf(created.competition, payer.principalId).seat;
    const opponentSeat = entrantOf(created.competition, opponent.principalId).seat;
    expect(payerSeat).not.toBe(opponentSeat);

    // Create replays on its real idempotency key without a second reservation.
    const replay = await competitions.createCompetition(walletCreateRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.competition.id).toBe(competitionId);

    // Sponsor prize reservation is real, balanced and singular.
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(operatorBefore - PRIZE_ATOMIC);
    expect(await prizeReserve(competitionId)).toBe(PRIZE_ATOMIC);
    expect(await journalCount(`competition-prize-reserve:${competitionId}`)).toBe(1);

    // A start before the configured payer opts in fails closed.
    await expect(competitions.start(competitionId)).rejects.toMatchObject({
      code: "COMPETITION_ENTRY_UNPAID",
    });

    // Opt-in once: the entry is held in the competition's own reserve.
    const optIn = await payerCompetitions.optIn(competitionId);
    expect(optIn.entryState).toBe("PAID");
    expect(optIn.entry.amountAtomic).toBe(ENTRY_ATOMIC.toString());
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(
      PAYER_CLAIM_ATOMIC - ENTRY_ATOMIC
    );
    expect(await entryReserve(competitionId)).toBe(ENTRY_ATOMIC);
    expect(
      await journalCount(`competition-entry-reserve:${competitionId}:${payer.principalId}`)
    ).toBe(1);
    // Retry replays the same journal; no second charge.
    const optInReplay = await payerCompetitions.optIn(competitionId);
    expect(optInReplay.journalRequestId).toBe(optIn.journalRequestId);
    expect(await entryReserve(competitionId)).toBe(ENTRY_ATOMIC);

    // Start releases the held entry to the sponsor exactly once and seats every
    // entrant at its authoritative seat.
    const started = await competitions.start(competitionId);
    expect(started.tableId).toBe(created.competition.tableId);
    expect(new Map(started.seats.map((seat) => [seat.principalId, seat.seat]))).toEqual(
      new Map([
        [payer.principalId, payerSeat],
        [opponent.principalId, opponentSeat],
      ])
    );
    expect(await entryReserve(competitionId)).toBe(0n);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(
      operatorBefore - PRIZE_ATOMIC + ENTRY_ATOMIC
    );
    expect(
      await journalCount(`competition-entry-release:${competitionId}:${payer.principalId}`)
    ).toBe(1);
    const running = await competitions.getCompetition(competitionId);
    expect(running.status).toBe("RUNNING");
    expect(
      running.entrants.find((entry) => entry.principalId === payer.principalId)?.entryState
    ).toBe("PAID");

    // Canonical HTTP/SDK gameplay over the listening API socket.
    const tableState = await payer.client.getTableState(started.tableId);
    expect(tableState).not.toBeNull();
    for (const [principalId, seat] of [
      [payer.principalId, payerSeat],
      [opponent.principalId, opponentSeat],
    ] as const) {
      expect(tableState!.players[seat]?.id).toBe(principalId);
    }
    const payerSession: GameplaySession = {
      principalId: payer.principalId,
      client: pokerClient(payer),
    };
    const opponentSession: GameplaySession = {
      principalId: opponent.principalId,
      client: pokerClient(opponent),
    };
    const played = await playToBust({
      tableId: started.tableId,
      winner: payerSession,
      folder: opponentSession,
    });
    expect(played.actions).toBeGreaterThan(0);
    expect(played.deals).toBeGreaterThan(0);
    const actionReceipts = await prisma.gameActionRequest.count({
      where: { tableId: started.tableId },
    });
    expect(actionReceipts).toBeGreaterThan(0);

    const competitionRow = await prisma.competition.findUniqueOrThrow({
      where: { id: competitionId },
      select: { tournamentId: true },
    });
    const tableAfterPlay = await payer.client.getTableState(started.tableId);
    const liveWinnerId = liveWinnerFromState(tableAfterPlay!);
    expect(liveWinnerId).not.toBeNull();

    // Durable crash boundary: settle the BACKING tournament through the public
    // tournament route (the sponsor is its ADMIN creator). This produces exactly
    // the durable state a crash between the tournament settlement commit and the
    // competition disposition transaction leaves: tournament FINISHED,
    // competition still RUNNING with the prize reserved.
    await sponsor.client.settleTournament(competitionRow.tournamentId);
    const tournamentAfter = await prisma.tournament.findUniqueOrThrow({
      where: { id: competitionRow.tournamentId },
    });
    expect(tournamentAfter.status).toBe("FINISHED");
    const interrupted = await prisma.competition.findUniqueOrThrow({
      where: { id: competitionId },
    });
    expect(interrupted.status).toBe("RUNNING");
    expect(interrupted.prizeStatus).toBe("RESERVED");
    expect(await prizeReserve(competitionId)).toBe(PRIZE_ATOMIC);

    // Crash and reboot the API process over the same durable PostgreSQL/Redis.
    await closeFinanceApi();
    await bootListeningApp();
    // Re-authenticate the real wallet sessions against the restarted process.
    payer = await sdkLogin(getAccount(PAYER_INDEX), baseUrl);
    sponsor = await sdkLogin(getAccount(SPONSOR_INDEX), baseUrl);
    opponent = await sdkLogin(getAccount(OPPONENT_INDEX), baseUrl);
    const restartedCompetitions = competitionClient(sponsor);

    const winnerBefore = await balanceOf(liveWinnerId!, "USER_AVAILABLE");
    const sponsorBeforeSettle = await balanceOf(sponsor.principalId, "OPERATOR");

    // Concurrent settle retries after restart: exactly one disposition.
    const settlements = await Promise.all([
      restartedCompetitions.settle(competitionId),
      restartedCompetitions.settle(competitionId),
      restartedCompetitions.settle(competitionId),
      restartedCompetitions.settle(competitionId),
    ]);
    for (const settlement of settlements) {
      expect(settlement.prizeStatus).toBe("PAID");
      expect(settlement.winnerKind).toBe("WALLET");
      expect(settlement.winnerPrincipalId).toBe(liveWinnerId);
      expect(settlement.prize?.amountAtomic).toBe(PRIZE_ATOMIC.toString());
    }
    const settled: SettleCompetitionResponse = settlements[0];
    expect(settled.placements.find((placement) => placement.placement === 1)?.principalId).toBe(
      liveWinnerId
    );

    // Prize paid once, reserve drained, sponsor keeps exactly the released entry.
    expect(await balanceOf(liveWinnerId!, "USER_AVAILABLE")).toBe(winnerBefore + PRIZE_ATOMIC);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(sponsorBeforeSettle);
    expect(await prizeReserve(competitionId)).toBe(0n);
    expect(await journalCount(`competition-prize-settlement:${competitionId}`)).toBe(1);
    const finished = await prisma.competition.findUniqueOrThrow({ where: { id: competitionId } });
    expect(finished.status).toBe("FINISHED");
    expect(finished.prizeStatus).toBe("PAID");
    expect(finished.prizeSettlementJournalId).not.toBeNull();

    // A further settle retry replays the accepted disposition without a journal.
    const retry = await restartedCompetitions.settle(competitionId);
    expect(retry.prizeStatus).toBe("PAID");
    expect(await journalCount(`competition-prize-settlement:${competitionId}`)).toBe(1);
    await assertAssetSettledBalanced();
  }, 300_000);

  it("releases the prize exactly once when the winner is SERVICE", async () => {
    const competitions = competitionClient(sponsor);
    const payerCompetitions = competitionClient(payer);

    const service = await sponsor.client.provisionServicePrincipal({
      name: `accept-service-${randomUUID().slice(0, 8)}`,
    });
    expect(service.kind).toBe("SERVICE");

    const operatorBefore = await balanceOf(sponsor.principalId, "OPERATOR");
    const created = await competitions.createCompetition({
      name: `accept-service-${randomUUID().slice(0, 8)}`,
      mode: "ASSET",
      entrants: [
        { principalId: payer.principalId, kind: "WALLET" },
        { principalId: service.principalId, kind: "SERVICE" },
      ],
      startingStack: 60,
      smallBlind: 10,
      bigBlind: 20,
      terms: {
        entry: {
          assetId,
          amountAtomic: ENTRY_ATOMIC.toString(),
          payers: [{ principalId: payer.principalId }],
        },
        prize: {
          assetId,
          amountAtomic: PRIZE_ATOMIC.toString(),
          sponsorPrincipalId: sponsor.principalId,
        },
      },
      idempotencyKey: `accept-service:${randomUUID()}`,
    });
    const competitionId = created.competition.id;
    assertSeatsAreAssigned(created.competition);
    const payerSeat = entrantOf(created.competition, payer.principalId).seat;
    const serviceSeat = entrantOf(created.competition, service.principalId).seat;
    expect(await prizeReserve(competitionId)).toBe(PRIZE_ATOMIC);

    await payerCompetitions.optIn(competitionId);
    const started = await competitions.start(competitionId);
    expect(await entryReserve(competitionId)).toBe(0n);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(
      operatorBefore - PRIZE_ATOMIC + ENTRY_ATOMIC
    );

    // The SERVICE entrant plays through a table-scoped agent credential issued
    // by the public orchestration route.
    const issued = await competitions.issueAgentCredential(competitionId, {
      principalId: service.principalId,
      name: "accept-service-agent",
    });
    expect(issued.seat).toBeNull();
    const serviceClient = new PokerClient({
      baseUrl,
      token: issued.token,
      timeout: 20_000,
      retry: { count: 2, delay: 100, backoff: 2 },
    });
    const stateBeforePlay = await serviceClient.getTableState(started.tableId);
    expect(stateBeforePlay!.players[serviceSeat]?.id).toBe(service.principalId);
    expect(stateBeforePlay!.players[payerSeat]?.id).toBe(payer.principalId);

    const played = await playToBust({
      tableId: started.tableId,
      winner: { principalId: service.principalId, client: serviceClient },
      folder: { principalId: payer.principalId, client: pokerClient(payer) },
    });
    expect(played.actions).toBeGreaterThan(0);
    expect(played.deals).toBeGreaterThan(0);

    const tableAfterPlay = await serviceClient.getTableState(started.tableId);
    const liveWinnerId = liveWinnerFromState(tableAfterPlay!);
    expect(liveWinnerId).toBe(service.principalId);

    const payerBeforeSettle = await balanceOf(payer.principalId, "USER_AVAILABLE");
    const sponsorBeforeSettle = await balanceOf(sponsor.principalId, "OPERATOR");
    const settlements = await Promise.all([
      competitions.settle(competitionId),
      competitions.settle(competitionId),
    ]);
    for (const settlement of settlements) {
      expect(settlement.winnerKind).toBe("SERVICE");
      expect(settlement.winnerPrincipalId).toBe(service.principalId);
      expect(settlement.prizeStatus).toBe("RELEASED");
      expect(settlement.prize).toBeNull();
    }

    // No value is created: the payer keeps its post-entry balance and the whole
    // reservation (entry + prize) returns to the sponsor's operator account.
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(payerBeforeSettle);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(
      sponsorBeforeSettle + PRIZE_ATOMIC
    );
    expect(await prizeReserve(competitionId)).toBe(0n);
    expect(await journalCount(`competition-prize-settlement:${competitionId}`)).toBe(1);
    expect(
      await journalCount(`competition-entry-release:${competitionId}:${payer.principalId}`)
    ).toBe(1);
    await assertAssetSettledBalanced();
  }, 300_000);

  it("refunds the held entry and releases the prize exactly once on cancellation", async () => {
    const competitions = competitionClient(sponsor);
    const payerCompetitions = competitionClient(payer);

    const operatorBefore = await balanceOf(sponsor.principalId, "OPERATOR");
    const payerBefore = await balanceOf(payer.principalId, "USER_AVAILABLE");
    const created = await competitions.createCompetition({
      name: `accept-cancel-${randomUUID().slice(0, 8)}`,
      mode: "ASSET",
      entrants: [
        { principalId: payer.principalId, kind: "WALLET" },
        { principalId: opponent.principalId, kind: "WALLET" },
      ],
      terms: {
        entry: {
          assetId,
          amountAtomic: ENTRY_ATOMIC.toString(),
          payers: [{ principalId: payer.principalId }],
        },
        prize: {
          assetId,
          amountAtomic: PRIZE_ATOMIC.toString(),
          sponsorPrincipalId: sponsor.principalId,
        },
      },
      idempotencyKey: `accept-cancel:${randomUUID()}`,
    });
    const competitionId = created.competition.id;
    assertSeatsAreAssigned(created.competition);
    expect(await prizeReserve(competitionId)).toBe(PRIZE_ATOMIC);

    await payerCompetitions.optIn(competitionId);
    expect(await entryReserve(competitionId)).toBe(ENTRY_ATOMIC);
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(payerBefore - ENTRY_ATOMIC);

    // Concurrent cancellation retries: exactly one refund and one release.
    const cancellations = await Promise.all([
      competitions.cancel(competitionId),
      competitions.cancel(competitionId),
      competitions.cancel(competitionId),
    ]);
    for (const cancellation of cancellations) {
      expect(cancellation.status).toBe("CANCELLED");
      expect(cancellation.prizeStatus).toBe("RELEASED");
      expect(cancellation.prize?.amountAtomic).toBe(PRIZE_ATOMIC.toString());
      const payerEntry = cancellation.entries.find(
        (entry) => entry.principalId === payer.principalId
      );
      expect(payerEntry?.entryState).toBe("REFUNDED");
      expect(payerEntry?.refunded).toBe(true);
      expect(payerEntry?.refundJournalId).not.toBeNull();
      const opponentEntry = cancellation.entries.find(
        (entry) => entry.principalId === opponent.principalId
      );
      expect(opponentEntry?.entryState).toBe("NOT_REQUIRED");
      expect(opponentEntry?.refunded).toBe(false);
    }
    const firstCancellation: CancelCompetitionResponse = cancellations[0];

    // Entry refunded once; prize released once; both reserves empty.
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(payerBefore);
    expect(await balanceOf(sponsor.principalId, "OPERATOR")).toBe(operatorBefore);
    expect(await entryReserve(competitionId)).toBe(0n);
    expect(await prizeReserve(competitionId)).toBe(0n);
    expect(
      await journalCount(`competition-entry-refund:${competitionId}:${payer.principalId}`)
    ).toBe(1);
    expect(await journalCount(`competition-prize-settlement:${competitionId}`)).toBe(1);

    // Replay is durable and truthful: same facts, no second movement.
    const replay = await competitions.cancel(competitionId);
    expect(replay.cancelledAt).toBe(firstCancellation.cancelledAt);
    expect(
      replay.entries.find((entry) => entry.principalId === payer.principalId)?.refundJournalId
    ).toBe(
      firstCancellation.entries.find((entry) => entry.principalId === payer.principalId)
        ?.refundJournalId
    );
    expect(await balanceOf(payer.principalId, "USER_AVAILABLE")).toBe(payerBefore);
    expect(
      await journalCount(`competition-entry-refund:${competitionId}:${payer.principalId}`)
    ).toBe(1);

    const cancelled = await prisma.competition.findUniqueOrThrow({ where: { id: competitionId } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).not.toBeNull();
    // A cancelled competition can never start.
    await expect(competitions.start(competitionId)).rejects.toMatchObject({
      code: "COMPETITION_NOT_REGISTERING",
    });
    await assertAssetSettledBalanced();
  }, 300_000);

  it("keeps only real, balanced per-asset journals with every reserve empty", async () => {
    await assertAssetSettledBalanced();

    const requestIds = await assetJournalRequestIds();
    for (const requestId of requestIds) {
      expect(
        ALLOWED_JOURNAL_PREFIXES.some((prefix) => requestId.startsWith(prefix)),
        `unexpected journal identity on the asset: ${requestId}`
      ).toBe(true);
    }
    // Two real deposit claims + one declared classification fixture + three
    // competitions x (reserve + entry + release/refund + settlement) journals.
    expect(requestIds).toHaveLength(2 + 1 + 3 * 4);

    const reserves = await prisma.atomicAccount.findMany({
      where: {
        assetId,
        class: "TOURNAMENT_RESERVE",
      },
      select: { ownerId: true, balanceAtomic: true },
    });
    for (const reserve of reserves) {
      expect(reserve.balanceAtomic, `reserve ${String(reserve.ownerId)} must be empty`).toBe("0");
    }
    const competitions = await prisma.competition.findMany({
      where: { organizerId: sponsor.principalId },
      select: { id: true, mode: true, status: true, prizeStatus: true },
    });
    expect(competitions.length).toBeGreaterThanOrEqual(3);
    for (const competition of competitions) {
      if (competition.mode !== "ASSET") continue;
      expect(await entryReserve(competition.id)).toBe(0n);
      expect(await prizeReserve(competition.id)).toBe(0n);
    }
  }, 120_000);
});
