/**
 * Production-container acceptance suite.
 *
 * This suite exercises the real production Docker image inside the real
 * `docker-compose.prod.yml` topology (api, worker, custody, postgres, redis)
 * with a disposable compose project. It never starts the API in-process, never
 * enables test routes and never credits money through a shortcut:
 *
 *  - every user balance under assertion is funded by a real MockUSDC transfer
 *    to the treasury followed by the public exact-log claim;
 *  - the only PostgreSQL bootstrap fixtures are the canonical asset registry
 *    row and the ADMIN role on an already SIWE-authenticated wallet;
 *  - gameplay runs through the public SIWE SDK (REST + WebSocket) against the
 *    containerized API;
 *  - ASSET competitions reserve, opt in, start, cancel and settle through the
 *    real competition service;
 *  - a real EIP-712 withdrawal is signed and finalized by the isolated custody
 *    container (persist-before-broadcast, confirmations, deep finality,
 *    reconciliation), then api + custody are restarted to prove receipts
 *    survive and value is never paid twice.
 *
 * One declared infrastructure fixture exists: the sponsor prize budget is a
 * balanced, net-zero `USER_AVAILABLE -> OPERATOR` classification of already
 * claimed funds (no public route classifies sponsor budget). It creates no
 * value; the on-chain backing and total liabilities are unchanged.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import WebSocket from "ws";
import {
  CompetitionClient,
  DepositClaimRequestSchema,
  PokerClient,
  PokerSDKError,
  PokerSocket,
  WithdrawalIntentSchema,
  WithdrawalSubmissionSchema,
  bigIntToAtomicAmount,
  createSiweMessage,
  withdrawalIntentTypedData,
  type CancelCompetitionResponse,
  type CanonicalActionRequest,
  type CompetitionTerms,
  type LegalActionFamily,
  type PublicWireState,
  type SeatObservation,
  type WithdrawalIntent,
  type WithdrawalSubmission,
} from "@pokertools/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { readHandoff, runCompose, sleep, waitFor } from "./helpers/prod-harness.js";

const execFileAsync = promisify(execFile);
const handoff = readHandoff();

const CHAIN_ID = handoff.chain.chainId;
const ASSET_ID = `eip155:${CHAIN_ID}/erc20:${handoff.chain.usdcAddress.toLowerCase()}`;
const TREASURY = handoff.chain.treasuryAddress.toLowerCase() as Address;
const USDC = handoff.chain.usdcAddress;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

const USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const localChain = defineChain({
  id: CHAIN_ID,
  name: "Anvil Production Acceptance",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [handoff.chain.anvilRpc] } },
});

const publicClient = createPublicClient({
  chain: localChain,
  transport: http(handoff.chain.anvilRpc),
});
const deployer = privateKeyToAccount(handoff.chain.treasuryPrivateKey);
const deployerWallet = createWalletClient({
  chain: localChain,
  transport: http(handoff.chain.anvilRpc),
  account: deployer,
});

interface TestUser {
  account: PrivateKeyAccount;
  client: PokerClient;
  token: string;
  userId: string;
}

let db: pg.Client;
let player1: TestUser;
let player2: TestUser;
let winnerUser: TestUser | undefined;
let withdrawalIntentId: string;
let withdrawalSubmission: WithdrawalSubmission;
let withdrawalDestination: Address;
let withdrawalAmount: bigint;
let withdrawalRecordBefore: WithdrawalRow;

interface WithdrawalRow {
  state: string;
  txHash: string | null;
  signedRawTx: string | null;
  confirmedJournalId: string | null;
  payloadHash: string | null;
}

interface ReconciliationRow {
  id: string;
  status: string;
  observedAtomic: string;
  ledgerAtomic: string;
  differenceAtomic: string;
  blockNumber: string | null;
  evidence: unknown;
  createdAt: Date;
}

let failureDiagnosticsCaptured = false;

// ============================================================================
// PostgreSQL helpers (host reads/bootstrap/assertions only)
// ============================================================================

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const result = await db.query<T>(text, values as never[]);
  return result.rows;
}

async function available(user: TestUser): Promise<bigint> {
  const balances = await user.client.getBalances();
  const entry = balances.find((balance) => balance.assetId === ASSET_ID);
  return entry ? BigInt(entry.availableAtomic) : 0n;
}

async function operatorBalance(user: TestUser): Promise<bigint> {
  const rows = await sql<{ balanceAtomic: string }>(
    `SELECT "balanceAtomic" FROM "AtomicAccount" WHERE "assetId"=$1 AND "ownerId"=$2 AND class='OPERATOR'::"AtomicAccountClass"`,
    [ASSET_ID, user.userId]
  );
  return rows[0] ? BigInt(rows[0].balanceAtomic) : 0n;
}

async function reserveBalance(ownerKey: string): Promise<bigint> {
  const rows = await sql<{ balanceAtomic: string }>(
    `SELECT "balanceAtomic" FROM "AtomicAccount" WHERE "assetId"=$1 AND "ownerKey"=$2 AND class='TOURNAMENT_RESERVE'::"AtomicAccountClass"`,
    [ASSET_ID, ownerKey]
  );
  return rows[0] ? BigInt(rows[0].balanceAtomic) : 0n;
}

async function pendingWithdrawal(user: TestUser): Promise<bigint> {
  const rows = await sql<{ balanceAtomic: string }>(
    `SELECT "balanceAtomic" FROM "AtomicAccount" WHERE "assetId"=$1 AND "ownerId"=$2 AND class='PENDING_WITHDRAWAL'::"AtomicAccountClass"`,
    [ASSET_ID, user.userId]
  );
  return rows[0] ? BigInt(rows[0].balanceAtomic) : 0n;
}

async function expectedTreasuryAtomic(): Promise<bigint> {
  const rows = await sql<{ expected: string }>(
    `SELECT COALESCE(SUM(CAST("balanceAtomic" AS DECIMAL)),0)::text AS expected FROM "AtomicAccount" WHERE "assetId"=$1 AND class <> 'TREASURY_RESERVE'::"AtomicAccountClass"`,
    [ASSET_ID]
  );
  return BigInt(rows[0].expected);
}

async function withdrawalRow(intentId: string): Promise<WithdrawalRow> {
  const rows = await sql<WithdrawalRow>(
    `SELECT state, "txHash", "signedRawTx", "confirmedJournalId", "payloadHash" FROM "WithdrawalIntentRecord" WHERE id=$1`,
    [intentId]
  );
  if (!rows[0]) throw new Error(`Withdrawal ${intentId} not found`);
  return rows[0];
}

/**
 * Wait for the custody container to finalize a withdrawal while mining blocks
 * so confirmations and deep finality mature. The chain uses automine, so block
 * height only changes here; independent quorum endpoints therefore agree on
 * every `eth_blockNumber` read (interval mining can straddle a block between
 * concurrent quorum reads and freeze the chain).
 */
async function waitForWithdrawalFinalized(
  intentId: string,
  timeoutMs: number
): Promise<WithdrawalRow> {
  const deadline = Date.now() + timeoutMs;
  let last: WithdrawalRow | undefined;
  while (Date.now() < deadline) {
    last = await withdrawalRow(intentId);
    if (last.state === "FINALIZED") return last;
    await publicClient.request({ method: "anvil_mine" as never, params: ["0x2"] as never });
    await sleep(1_500);
  }
  throw new Error(
    `Withdrawal ${intentId} did not finalize; last state=${last?.state ?? "unknown"}`
  );
}

interface ReadinessBody {
  status: string;
  financial?: { state: string };
  checks?: Array<{ name: string; state: string; detail: string }>;
}

/**
 * Poll `/ready` until the canonical financial state is READY. On timeout the
 * error carries the last observed check states (stable machine codes only).
 */
async function waitForFinancialReady(timeoutMs: number): Promise<ReadinessBody> {
  const deadline = Date.now() + timeoutMs;
  let last: ReadinessBody | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${handoff.apiBase}/ready`);
      const body = (await response.json()) as ReadinessBody;
      last = body;
      if (body.status === "ready" && body.financial?.state === "READY") return body;
    } catch {
      // The API may be mid-restart; retries are bounded.
    }
    await sleep(1_000);
  }
  const checks = (last?.checks ?? [])
    .filter((check) => check.state !== "READY")
    .map((check) => `${check.name}=${check.state}:${check.detail}`)
    .join(",");
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for financial readiness; ` +
      `last status=${last?.status ?? "unreachable"} financial=${last?.financial?.state ?? "unknown"} ` +
      `nonReady=[${checks}]`
  );
}

/** Balanced sealed journals + cached projection == immutable postings. */
async function expectLedgerBalanced(): Promise<void> {
  const unbalanced = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (SELECT "transactionId" FROM "JournalPosting" WHERE "assetId"=$1 GROUP BY "transactionId" HAVING SUM(CAST("amountAtomic" AS DECIMAL)) <> 0) x`,
    [ASSET_ID]
  );
  expect(unbalanced[0].n, "unbalanced journals").toBe("0");
  const drift = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (SELECT a.id FROM "AtomicAccount" a LEFT JOIN "JournalPosting" p ON p."accountId"=a.id WHERE a."assetId"=$1 GROUP BY a.id, a."balanceAtomic" HAVING CAST(a."balanceAtomic" AS DECIMAL) <> COALESCE(SUM(CAST(p."amountAtomic" AS DECIMAL)),0)) x`,
    [ASSET_ID]
  );
  expect(drift[0].n, "projection drift").toBe("0");
  const negative = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM "AtomicAccount" WHERE "assetId"=$1 AND "ownerId" IS NOT NULL AND CAST("balanceAtomic" AS DECIMAL) < 0`,
    [ASSET_ID]
  );
  expect(negative[0].n, "negative user-owned balances").toBe("0");
}

// ============================================================================
// Chain helpers (real transfers only)
// ============================================================================

async function treasuryTokenBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [TREASURY],
  });
}

async function tokenBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * Fund a wallet exclusively through the canonical path: gas grant, MockUSDC
 * mint, a real transfer from the authenticated wallet to the treasury, then
 * the public exact-log claim. No DB credit shortcut exists here.
 */
async function claimDeposit(user: TestUser, amountAtomic: bigint): Promise<void> {
  await deployerWallet.sendTransaction({
    to: user.account.address,
    value: parseUnits("0.5", 18),
  });
  const mintHash = await deployerWallet.writeContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "mint",
    args: [user.account.address, amountAtomic],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const userWallet = createWalletClient({
    chain: localChain,
    transport: http(handoff.chain.anvilRpc),
    account: user.account,
  });
  const transferHash = await userWallet.writeContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [TREASURY, amountAtomic],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
  const logIndex = receipt.logs.findIndex(
    (log) =>
      log.address.toLowerCase() === USDC.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[2]?.toLowerCase().endsWith(TREASURY.slice(2).toLowerCase())
  );
  expect(logIndex, "deposit Transfer log to treasury must exist").toBeGreaterThanOrEqual(0);

  // Mature the asset's confirmation threshold and let the RPC cache expire
  // before the exact-log verifier reads the canonical receipt.
  await publicClient.request({ method: "anvil_mine" as never, params: ["0x3"] as never });
  await sleep(1_500);

  const claim = await user.client.claimDeposit(
    DepositClaimRequestSchema.parse({ assetId: ASSET_ID, txHash: transferHash, logIndex })
  );
  expect(claim.amountAtomic).toBe(amountAtomic.toString());
}

/**
 * Declared infrastructure fixture: a balanced, net-zero
 * `USER_AVAILABLE -> OPERATOR` classification of already claimed sponsor
 * funds.
 *
 * There is no public route that classifies a wallet's claimed funds as
 * operator/sponsor budget, while ASSET prize reservation debits the sponsor's
 * OPERATOR account. This classification moves value between two accounts of
 * the same real principal, creates no value, changes neither the principal's
 * total nor the on-chain backing, and is committed as an ordinary balanced
 * journal (the PostgreSQL financial invariants verify it). It is idempotent on
 * its request id.
 */
async function classifySponsorBudget(sponsor: TestUser, amountAtomic: bigint): Promise<void> {
  const requestId = `pt-prod-accept:sponsor-budget:${sponsor.userId}`;
  const existing = await sql(`SELECT id FROM "JournalTransaction" WHERE "requestId"=$1`, [
    requestId,
  ]);
  if (existing.length > 0) return;

  await db.query("BEGIN");
  try {
    await db.query(`SELECT id FROM "Asset" WHERE id=$1 FOR UPDATE`, [ASSET_ID]);
    for (const accountClass of ["USER_AVAILABLE", "OPERATOR"]) {
      await db.query(
        `INSERT INTO "AtomicAccount" (id, "assetId", "ownerId", "ownerKey", class, "balanceAtomic", version, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $2, $3::"AtomicAccountClass", '0', 0, now(), now())
         ON CONFLICT ("assetId","ownerKey",class) DO NOTHING`,
        [ASSET_ID, sponsor.userId, accountClass]
      );
    }
    const accounts = await sql<{
      id: string;
      class: string;
      balanceAtomic: string;
      version: number;
    }>(
      `SELECT id, class, "balanceAtomic", version FROM "AtomicAccount" WHERE "assetId"=$1 AND "ownerKey"=$2 AND class IN ('USER_AVAILABLE'::"AtomicAccountClass",'OPERATOR'::"AtomicAccountClass")`,
      [ASSET_ID, sponsor.userId]
    );
    const from = accounts.find((account) => account.class === "USER_AVAILABLE");
    const to = accounts.find((account) => account.class === "OPERATOR");
    if (!from || !to) throw new Error("Sponsor classification accounts are missing");
    const fromBalance = BigInt(from.balanceAtomic);
    if (fromBalance < amountAtomic) {
      throw new Error("Sponsor USER_AVAILABLE is below the classification amount");
    }

    const transactionId = randomUUID();
    const postings = [
      { accountId: from.id, amountAtomic: `-${amountAtomic}` },
      { accountId: to.id, amountAtomic: amountAtomic.toString() },
    ].sort((a, b) => {
      if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
      if (a.amountAtomic !== b.amountAtomic) return a.amountAtomic < b.amountAtomic ? -1 : 1;
      return 0;
    });
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ assetId: ASSET_ID, postings }), "utf8")
      .digest("hex");

    await db.query(
      `UPDATE "AtomicAccount" SET "balanceAtomic"=$1, version=version+1, "updatedAt"=now() WHERE id=$2 AND version=$3`,
      [(fromBalance - amountAtomic).toString(), from.id, from.version]
    );
    await db.query(
      `UPDATE "AtomicAccount" SET "balanceAtomic"=$1, version=version+1, "updatedAt"=now() WHERE id=$2 AND version=$3`,
      [(BigInt(to.balanceAtomic) + amountAtomic).toString(), to.id, to.version]
    );
    await db.query(
      `INSERT INTO "JournalTransaction" (id,"assetId","requestId","payloadHash",sealed,"createdAt") VALUES ($1,$2,$3,$4,false,now())`,
      [transactionId, ASSET_ID, requestId, payloadHash]
    );
    await db.query(
      `INSERT INTO "JournalPosting" (id,"transactionId","assetId","accountId","amountAtomic","createdAt")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,now()), (gen_random_uuid()::text,$1,$2,$5,$6,now())`,
      [transactionId, ASSET_ID, from.id, `-${amountAtomic}`, to.id, amountAtomic.toString()]
    );
    await db.query(`UPDATE "JournalTransaction" SET sealed=true WHERE id=$1`, [transactionId]);
    await db.query(
      `UPDATE "Asset" SET "ledgerVersion"="ledgerVersion"+1, "updatedAt"=now() WHERE id=$1`,
      [ASSET_ID]
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

// ============================================================================
// SIWE / competition / gameplay helpers
// ============================================================================

async function authenticate(): Promise<TestUser> {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new PokerClient({ baseUrl: handoff.apiBase, retry: { count: 0 } });
  const nonce = await client.getNonce();
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN_ID,
    domain: "127.0.0.1",
    nonce,
    uri: handoff.apiBase,
    version: "1",
    statement: "PokerTools production-container acceptance",
    issuedAt: new Date(),
  });
  const login = await client.login({
    message,
    signature: await account.signMessage({ message }),
  });
  client.setToken(login.token);
  return { account, client, token: login.token, userId: login.user.id };
}

function competitionClient(user: TestUser): CompetitionClient {
  return new CompetitionClient({ baseUrl: handoff.apiBase, token: user.token });
}

function entrant(user: TestUser) {
  return { principalId: user.userId, kind: "WALLET" as const };
}

function toCanonicalActionRequest(
  observation: SeatObservation,
  requested: { type: LegalActionFamily; amount?: number }
): CanonicalActionRequest {
  const legal = observation.legalActions.find((action) => action.family === requested.type);
  if (!legal) {
    throw new Error(
      `Server did not offer a legal ${requested.type} action (offered: ${
        observation.legalActions.map((action) => action.family).join(", ") || "none"
      })`
    );
  }
  const bounded = legal.minAmount !== undefined || legal.maxAmount !== undefined;
  const amount = bounded ? (requested.amount ?? legal.amount ?? legal.minAmount) : legal.amount;
  if (bounded && amount === undefined) {
    throw new Error(`A chip amount is required for the ${requested.type} action`);
  }
  if (amount !== undefined && legal.minAmount !== undefined && amount < legal.minAmount) {
    throw new Error(
      `Amount ${amount} is below the minimum ${legal.minAmount} for ${requested.type}`
    );
  }
  if (amount !== undefined && legal.maxAmount !== undefined && amount > legal.maxAmount) {
    throw new Error(
      `Amount ${amount} is above the maximum ${legal.maxAmount} for ${requested.type}`
    );
  }
  return {
    requestId: randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: legal.actionId,
    ...(amount === undefined || amount === 0 ? {} : { amount }),
  };
}

/**
 * Resolve one canonical action from a fresh authoritative observation. A
 * stale/conflicting submission is re-resolved, never replayed blind.
 */
async function actWithObservation(
  client: PokerClient,
  tableId: string,
  choose: (observation: SeatObservation) => { type: LegalActionFamily; amount?: number }
): Promise<PublicWireState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observation = await client.getObservation(tableId);
    try {
      const requested = choose(observation);
      return (await client.action(tableId, toCanonicalActionRequest(observation, requested)))
        .observation.state;
    } catch (error) {
      const conflict =
        error instanceof PokerSDKError &&
        (error.statusCode === 409 || error.code === "GAME_CONFLICT" || error.code === "STALE_TURN");
      if (!conflict) throw error;
      lastError = error;
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("canonical action conflict");
}

async function requireTableState(client: PokerClient, tableId: string): Promise<PublicWireState> {
  const state = await client.getTableState(tableId);
  if (!state) throw new Error(`No table state for ${tableId}`);
  return state;
}

/**
 * Director reconciliation for a running competition. `CompetitionClient` has
 * no reconcile method (it is a director operation, not a lifecycle mutation),
 * so the authenticated public route is called directly.
 */
async function reconcileCompetition(token: string, competitionId: string): Promise<void> {
  const response = await fetch(
    `${handoff.apiBase}/competitions/${encodeURIComponent(competitionId)}/reconcile`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(`competition reconcile failed with status ${response.status}`);
  }
}

/**
 * Play a competition to completion through the canonical SDK protocol: at
 * every decision point the acting seat shoves when a raise is legal (or
 * calls/checks/folds), so a 2-seat competition resolves in one or two real
 * hands. At every hand boundary the director is reconciled (authoritative
 * eliminations) and the next hand is started with the server-issued DEAL
 * action until the competition reports `settlementReady`.
 */
async function playCompetitionToCompletion(
  admin: CompetitionClient,
  competitionId: string,
  tableId: string,
  users: TestUser[]
): Promise<PublicWireState> {
  const clientById = new Map(users.map((user) => [user.userId, user.client]));
  const anyClient = users[0].client;

  for (let hand = 0; hand < 12; hand += 1) {
    let state = await requireTableState(anyClient, tableId);

    if (state.actionTo === null) {
      // Hand boundary: a completed hand or a fresh table. Check the
      // authoritative completion projection before dealing anything new.
      let competition = await admin.getCompetition(competitionId);
      if (competition.settlementReady || competition.status === "FINISHED") return state;
      console.log(
        `[prod-accept] boundary on ${tableId}: status=${competition.status} ` +
          `settlementReady=${competition.settlementReady} ` +
          `entrants=${competition.entrants.map((entrant) => `${entrant.seat}:${entrant.entryState}`).join(",")}`
      );
      await reconcileCompetition(users[0].token, competitionId);
      competition = await admin.getCompetition(competitionId);
      if (competition.settlementReady || competition.status === "FINISHED") return state;
      console.log(
        `[prod-accept] after reconcile on ${tableId}: status=${competition.status} ` +
          `settlementReady=${competition.settlementReady} ` +
          `entrants=${competition.entrants.map((entrant) => `${entrant.seat}:${entrant.entryState}`).join(",")}`
      );

      const observation = await anyClient.getObservation(tableId);
      if (!observation.legalActions.some((action) => action.family === "DEAL")) {
        // The authoritative auto-deal may not have fired yet.
        await sleep(1_500);
        continue;
      }
      state = await actWithObservation(anyClient, tableId, () => ({ type: "DEAL" }));
    }

    let steps = 0;
    while (state.actionTo !== null && steps < 80) {
      const actor = state.players[state.actionTo];
      if (!actor) throw new Error(`No player at actionTo=${state.actionTo} on ${tableId}`);
      const actorClient = clientById.get(actor.id);
      if (!actorClient) throw new Error(`No authenticated client for acting player ${actor.id}`);
      state = await actWithObservation(actorClient, tableId, (observation) => {
        const shove = observation.legalActions.find(
          (action) => action.family === "RAISE" || action.family === "BET"
        );
        const choice = shove
          ? { type: shove.family, amount: shove.maxAmount ?? shove.amount }
          : observation.legalActions.some((action) => action.family === "CALL")
            ? { type: "CALL" as const }
            : observation.legalActions.some((action) => action.family === "CHECK")
              ? { type: "CHECK" as const }
              : { type: "FOLD" as const };
        console.log(
          `[prod-accept] action on ${tableId}: actor=${actor.id} offered=` +
            `${observation.legalActions.map((action) => action.family).join(",")} -> ` +
            `${choice.type}${choice.amount !== undefined ? ` ${choice.amount}` : ""}`
        );
        return choice;
      });
      steps += 1;
      console.log(
        `[prod-accept] state on ${tableId}: actionTo=${state.actionTo ?? "null"} ` +
          `stacks=${state.players.map((player) => player?.stack ?? "null").join(",")} ` +
          `winners=${(state.winners ?? []).map((winner) => `${winner.seat}:${winner.amount}`).join(",") || "none"}`
      );
    }
    if (state.actionTo !== null) {
      throw new Error(`Hand did not complete within the step budget on ${tableId}`);
    }
    console.log(
      `[prod-accept] hand ${hand + 1} complete on ${tableId}: ` +
        `stacks=${state.players.map((player) => player?.stack ?? "null").join(",")} ` +
        `winners=${(state.winners ?? []).map((winner) => `${winner.seat}:${winner.amount}`).join(",") || "none"}`
    );
  }
  throw new Error(`Competition ${competitionId} did not complete within the hand budget`);
}

// ============================================================================
// Lifecycle
// ============================================================================

beforeAll(async () => {
  db = new pg.Client({
    host: handoff.pg.host,
    port: handoff.pg.port,
    user: handoff.pg.user,
    password: handoff.pg.password,
    database: handoff.pg.database,
  });
  await db.connect();
  // Connection teardown (compose down -v) must never surface as an unhandled
  // exception; the suite only reads through this client.
  db.on("error", () => undefined);
});

afterAll(async () => {
  if (db) await db.end().catch(() => undefined);
});

async function dumpDiagnostics(label: string): Promise<void> {
  const { redact } = await import("./helpers/prod-harness.js");
  console.error(`[prod-accept] ${label}`);
  try {
    const ps = await runCompose(["ps"], { allowFailure: true, timeoutMs: 20_000 });
    console.error(redact(ps));
  } catch {
    console.error("[prod-accept] compose ps unavailable");
  }
  for (const service of ["api", "worker", "custody"]) {
    try {
      const logs = await runCompose(["logs", "--no-color", "--tail", "120", service], {
        allowFailure: true,
        timeoutMs: 30_000,
      });
      console.error(redact(`[prod-accept] ${service} logs:\n${logs}`));
    } catch {
      console.error(`[prod-accept] ${service} logs unavailable`);
    }
  }
}

/** Automatic restart count; a crash-looping service is never acceptable. */
async function containerRestartCount(service: string): Promise<number> {
  const containerId = (await runCompose(["ps", "-q", service])).trim().split(/\s+/)[0];
  if (!containerId) throw new Error(`No container for service ${service}`);
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    "--format",
    "{{.RestartCount}}",
    containerId,
  ]);
  return Number(stdout.trim());
}

/** Re-resolve the loopback API port after a restart and wait for health. */
async function waitForApiAfterRestart(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const output = (await runCompose(["port", "api", "3000"])).trim();
      const port = output.split(":").pop();
      if (port && /^\d+$/.test(port)) {
        handoff.apiBase = `http://127.0.0.1:${port}`;
        const response = await fetch(`${handoff.apiBase}/health`);
        if (response.ok) return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `API did not become healthy after restart${lastError ? `: ${String(lastError)}` : ""}`
  );
}

beforeEach(() => {
  onTestFailed(async () => {
    if (failureDiagnosticsCaptured) return;
    failureDiagnosticsCaptured = true;
    await dumpDiagnostics("first failure diagnostics");
  });
});

// ============================================================================
// Tests
// ============================================================================

describe("production container acceptance", () => {
  it("runs the real production topology with custody-isolated secrets", async () => {
    const running = (await runCompose(["ps", "--status", "running", "--services"]))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    expect(new Set(running)).toEqual(new Set(["api", "worker", "custody", "postgres", "redis"]));
    expect(running).not.toContain("caddy");
    expect(running).not.toContain("backup");
    // A crash-looping service is "running" between restarts; the automatic
    // restart count proves each service is actually stable.
    for (const service of ["api", "worker", "custody"]) {
      expect(await containerRestartCount(service), `${service} restart count`).toBe(0);
    }

    const apiEnv = await runCompose(["exec", "-T", "api", "printenv"]);
    const apiIsProduction = /^NODE_ENV=production$/m.test(apiEnv);
    const apiHasCustodyKey = /^TREASURY_SIGNING_KEYS_JSON=/m.test(apiEnv);
    const apiHasTestRoutesEnabled = /^ENABLE_TEST_ROUTES=true$/m.test(apiEnv);
    expect(apiIsProduction).toBe(true);
    expect(apiHasCustodyKey).toBe(false);
    expect(apiHasTestRoutesEnabled).toBe(false);

    // Custody is the only process that receives signing material; never print it.
    await runCompose([
      "exec",
      "-T",
      "custody",
      "node",
      "-e",
      "process.exit(process.env.TREASURY_SIGNING_KEYS_JSON ? 0 : 1)",
    ]);

    const health = (await (await fetch(`${handoff.apiBase}/health`)).json()) as { status: string };
    expect(health.status).toBe("ok");
  });

  it("authenticates two real SIWE wallets and bootstraps one ADMIN role via PostgreSQL", async () => {
    player1 = await authenticate();
    player2 = await authenticate();
    expect(player1.userId).not.toBe(player2.userId);

    const principals = await Promise.all([
      player1.client.getPrincipal(),
      player2.client.getPrincipal(),
    ]);
    expect(principals.map((principal) => principal.kind)).toEqual(["WALLET", "WALLET"]);

    await sql(`UPDATE "User" SET role='ADMIN'::"Role", "updatedAt"=now() WHERE id=$1`, [
      player1.userId,
    ]);
    const roles = await sql<{ role: string }>(`SELECT role FROM "User" WHERE id=$1`, [
      player1.userId,
    ]);
    expect(roles[0].role).toBe("ADMIN");

    // No money has moved: both wallets are empty before any real deposit.
    expect(await available(player1)).toBe(0n);
    expect(await available(player2)).toBe(0n);
    const accounts = await sql(`SELECT id FROM "AtomicAccount" WHERE "assetId"=$1`, [ASSET_ID]);
    expect(accounts).toHaveLength(0);
  });

  it("bootstraps the canonical asset registry row and reaches financial READY", async () => {
    await sql(
      `INSERT INTO "Asset" (id,"chainId","tokenAddress",symbol,decimals,status,confirmations,"deepFinality","treasuryAddress","rpcUrls","minGasAtomic","ledgerVersion","createdAt","updatedAt")
       VALUES ($1,$2,$3,'USDC',6,'ACTIVE'::"AssetStatus",1,3,$4,$5::jsonb,'100000000000000000',0,now(),now())`,
      [
        ASSET_ID,
        CHAIN_ID,
        USDC.toLowerCase(),
        TREASURY,
        JSON.stringify(handoff.chain.containerRpcUrls),
      ]
    );

    // The asset registry fixture must exist before the worker's canonical
    // deposit monitor builds its chain registry; restarting the worker here
    // mirrors the production bootstrap order (registry seed -> workers) and
    // avoids a stale empty registry. Restarting custody immediately runs its
    // startup reconciliation pass, which records the first MATCHED treasury
    // reconciliation for the route.
    await runCompose(["restart", "custody", "worker"], { timeoutMs: 120_000 });

    await waitFor(
      async () => {
        const rows = await sql<{ status: string }>(
          `SELECT status FROM "TreasuryReconciliation" WHERE "assetId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
          [ASSET_ID]
        );
        return rows[0]?.status === "MATCHED" ? rows[0] : null;
      },
      120_000,
      1_000,
      "custody reconciliation MATCHED"
    );
    await waitFor(
      async () => {
        const rows = await sql<{ signerReady: boolean; gasReady: boolean }>(
          `SELECT "signerReady","gasReady" FROM "CustodyHeartbeat" WHERE "chainId"=$1 AND lower("signerAddress")=$2 ORDER BY "observedAt" DESC LIMIT 1`,
          [CHAIN_ID, TREASURY]
        );
        return rows[0]?.signerReady && rows[0]?.gasReady ? rows[0] : null;
      },
      120_000,
      1_000,
      "custody signer/gas heartbeat"
    );

    const ready = await waitForFinancialReady(120_000);
    const checks = new Map((ready.checks ?? []).map((check) => [check.name, check.state]));
    for (const name of [
      "database",
      "migrations",
      "redis",
      "queue",
      "gameAuthority",
      "provenance",
      "ledger",
      "assets",
      "incidents",
      "rpcQuorum",
      "reconciliation",
      "custody",
      "nativeGas",
      "freeze",
    ]) {
      expect(checks.get(name), `readiness check ${name}`).toBe("READY");
    }

    // Registry bootstrap only: no journal, no balance, no on-chain movement.
    const journals = await sql(`SELECT id FROM "JournalTransaction" WHERE "assetId"=$1`, [
      ASSET_ID,
    ]);
    expect(journals).toHaveLength(0);
    expect(await treasuryTokenBalance()).toBe(0n);
    const incidents = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "FinancialIncident" WHERE status <> 'RESOLVED'`
    );
    expect(incidents[0].n, "open financial incidents after bootstrap").toBe("0");
  });

  it("funds both wallets only through real on-chain transfers + exact-log claims", async () => {
    await claimDeposit(player1, 100_000_000n);
    await claimDeposit(player2, 100_000_000n);

    expect(await available(player1)).toBe(100_000_000n);
    expect(await available(player2)).toBe(100_000_000n);
    expect(await treasuryTokenBalance()).toBe(200_000_000n);

    const claims = await sql<{
      status: string;
      creditedJournalId: string | null;
      blockNumber: string | null;
      blockHash: string | null;
      provenance: string;
    }>(
      `SELECT status,"creditedJournalId","blockNumber","blockHash",provenance FROM "DepositClaimRecord" WHERE "assetId"=$1`,
      [ASSET_ID]
    );
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.status).toBe("CREDITED");
      expect(claim.creditedJournalId).toBeTruthy();
      expect(claim.blockNumber).not.toBeNull();
      expect(claim.blockHash).not.toBeNull();
      expect(claim.provenance).toBe("DIRECT_TREASURY");
    }
    await expectLedgerBalanced();
  });

  it("plays and completes a public 2-seat game through the real SIWE SDK + WebSocket", async () => {
    const admin = competitionClient(player1);
    const created = await admin.createCompetition({
      name: "Acceptance NONFINANCIAL 2-seat",
      mode: "NONFINANCIAL",
      entrants: [entrant(player1), entrant(player2)],
      startingStack: 1_000,
      smallBlind: 10,
      bigBlind: 20,
      idempotencyKey: randomUUID(),
    });
    expect(created.competition.status).toBe("REGISTRATION");

    const started = await admin.start(created.competition.id);
    expect(started.seats).toHaveLength(2);

    const socket = new PokerSocket({
      url: handoff.wsUrl,
      token: player2.token,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatInterval: 5_000,
      reconnectAttempts: 0,
    });
    await socket.connect();
    try {
      const snapshot = await socket.join(started.tableId);
      expect(snapshot.state.players.filter(Boolean)).toHaveLength(2);

      const updatePromise = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for WebSocket stateUpdate")),
          30_000
        );
        socket.on("stateUpdate", (updatedTableId, state) => {
          if (updatedTableId === started.tableId && state.version > snapshot.version) {
            clearTimeout(timeout);
            resolve(state.version);
          }
        });
      });

      const finalState = await playCompetitionToCompletion(
        admin,
        created.competition.id,
        started.tableId,
        [player1, player2]
      );
      expect(finalState.actionTo).toBeNull();
      expect(finalState.winners?.length ?? 0).toBeGreaterThan(0);
      expect(await updatePromise).toBeGreaterThan(snapshot.version);
      expect(socket.getCachedState(started.tableId)?.version).toBeGreaterThan(snapshot.version);
    } finally {
      socket.disconnect();
    }

    const settled = await admin.settle(created.competition.id);
    expect(settled.prizeStatus).toBe("NOT_APPLICABLE");
    expect(settled.winnerPrincipalId).toBeTruthy();
    const finished = await admin.getCompetition(created.competition.id);
    expect(finished.status).toBe("FINISHED");
  });

  it("reserves, opts in and cancels an ASSET competition with real refunds (SDK natural idempotency)", async () => {
    // Sponsor budget: a balanced classification of real claimed funds only.
    await classifySponsorBudget(player1, 40_000_000n);
    expect(await available(player1)).toBe(60_000_000n);
    expect(await operatorBalance(player1)).toBe(40_000_000n);

    const before1 = await available(player1);
    const before2 = await available(player2);
    const admin = competitionClient(player1);
    const terms: CompetitionTerms = {
      entry: {
        assetId: ASSET_ID,
        amountAtomic: "10000000",
        payers: [
          { principalId: player1.userId, amountAtomic: "10000000" },
          { principalId: player2.userId, amountAtomic: "10000000" },
        ],
      },
      prize: { assetId: ASSET_ID, amountAtomic: "15000000", sponsorPrincipalId: player1.userId },
    };
    const created = await admin.createCompetition({
      name: "Acceptance ASSET cancel",
      mode: "ASSET",
      entrants: [entrant(player1), entrant(player2)],
      startingStack: 1_000,
      smallBlind: 10,
      bigBlind: 20,
      terms,
      idempotencyKey: randomUUID(),
    });
    expect(created.competition.mode).toBe("ASSET");
    expect(created.competition.prizeStatus).toBe("RESERVED");
    expect(created.competition.terms?.prize.amountAtomic).toBe("15000000");
    // Prize reservation debits the sponsor OPERATOR account, not user funds.
    expect(await operatorBalance(player1)).toBe(25_000_000n);
    expect(await reserveBalance(`competition-prize:${created.competition.id}`)).toBe(15_000_000n);

    const opt1 = await competitionClient(player1).optIn(created.competition.id);
    const opt2 = await competitionClient(player2).optIn(created.competition.id);
    expect(opt1.entryState).toBe("PAID");
    expect(opt2.entryState).toBe("PAID");
    expect(await available(player1)).toBe(before1 - 10_000_000n);
    expect(await available(player2)).toBe(before2 - 10_000_000n);
    expect(await reserveBalance(`competition-entry:${created.competition.id}`)).toBe(20_000_000n);

    const cancelled: CancelCompetitionResponse = await admin.cancel(created.competition.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.prizeStatus).toBe("RELEASED");
    expect(cancelled.prize?.amountAtomic).toBe("15000000");
    expect(cancelled.entries).toHaveLength(2);
    for (const entry of cancelled.entries) {
      expect(entry.entryState).toBe("REFUNDED");
      expect(entry.refunded).toBe(true);
      expect(entry.refundJournalId).toBeTruthy();
    }
    expect(await available(player1)).toBe(before1);
    expect(await available(player2)).toBe(before2);
    expect(await operatorBalance(player1)).toBe(40_000_000n);
    expect(await reserveBalance(`competition-entry:${created.competition.id}`)).toBe(0n);
    expect(await reserveBalance(`competition-prize:${created.competition.id}`)).toBe(0n);

    // Natural idempotency: no key, same durable facts, no second movement.
    const replay = await admin.cancel(created.competition.id);
    expect(replay.cancelledAt).toBe(cancelled.cancelledAt);
    expect(replay.prizeStatus).toBe("RELEASED");
    expect(replay.entries).toEqual(cancelled.entries);
    expect(await available(player1)).toBe(before1);
    expect(await available(player2)).toBe(before2);
    expect(await operatorBalance(player1)).toBe(40_000_000n);

    const durable = await sql<{ status: string; prizeStatus: string; cancelledAt: Date | null }>(
      `SELECT status,"prizeStatus","cancelledAt" FROM "Competition" WHERE id=$1`,
      [created.competition.id]
    );
    expect(durable[0].status).toBe("CANCELLED");
    expect(durable[0].prizeStatus).toBe("RELEASED");
    expect(durable[0].cancelledAt).toBeInstanceOf(Date);

    const entrants = await sql<{ entryState: string; refundJournalId: string | null }>(
      `SELECT "entryState","refundJournalId" FROM "CompetitionEntrant" WHERE "competitionId"=$1`,
      [created.competition.id]
    );
    expect(entrants).toHaveLength(2);
    for (const entrantRow of entrants) {
      expect(entrantRow.entryState).toBe("REFUNDED");
      expect(entrantRow.refundJournalId).toBeTruthy();
    }
    const tournament = await sql<{ status: string }>(
      `SELECT t.status FROM "Tournament" t JOIN "Competition" c ON c."tournamentId"=t.id WHERE c.id=$1`,
      [created.competition.id]
    );
    expect(tournament[0].status).toBe("CANCELLED");

    const refundJournals = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "JournalTransaction" WHERE "requestId" LIKE $1`,
      [`competition-entry-refund:${created.competition.id}:%`]
    );
    expect(refundJournals[0].n).toBe("2");
    await expectLedgerBalanced();
  });

  it("starts, completes and settles an ASSET competition paying the WALLET winner exactly once", async () => {
    const before1 = await available(player1);
    const before2 = await available(player2);
    const admin = competitionClient(player1);
    const terms: CompetitionTerms = {
      entry: {
        assetId: ASSET_ID,
        amountAtomic: "10000000",
        payers: [
          { principalId: player1.userId, amountAtomic: "10000000" },
          { principalId: player2.userId, amountAtomic: "10000000" },
        ],
      },
      prize: { assetId: ASSET_ID, amountAtomic: "20000000", sponsorPrincipalId: player1.userId },
    };
    const created = await admin.createCompetition({
      name: "Acceptance ASSET settle",
      mode: "ASSET",
      entrants: [entrant(player1), entrant(player2)],
      startingStack: 1_000,
      smallBlind: 10,
      bigBlind: 20,
      terms,
      idempotencyKey: randomUUID(),
    });
    expect(created.competition.prizeStatus).toBe("RESERVED");
    await competitionClient(player1).optIn(created.competition.id);
    await competitionClient(player2).optIn(created.competition.id);

    const started = await admin.start(created.competition.id);
    expect(started.seats).toHaveLength(2);
    const finalState = await playCompetitionToCompletion(
      admin,
      created.competition.id,
      started.tableId,
      [player1, player2]
    );
    expect(finalState.actionTo).toBeNull();
    expect(finalState.winners?.length ?? 0).toBeGreaterThan(0);

    const settled = await admin.settle(created.competition.id);
    expect(settled.prizeStatus).toBe("PAID");
    expect(settled.winnerKind).toBe("WALLET");
    expect(settled.prize?.amountAtomic).toBe("20000000");
    const winner = settled.winnerPrincipalId === player1.userId ? player1 : player2;
    winnerUser = winner;
    const winnerAfter = await available(winner);
    expect(winnerAfter).toBeGreaterThan(0n);

    // Replay is durably idempotent: same winner, same prize, no second payout.
    const replay = await admin.settle(created.competition.id);
    expect(replay.winnerPrincipalId).toBe(settled.winnerPrincipalId);
    expect(replay.prize?.amountAtomic).toBe("20000000");
    expect(await available(winner)).toBe(winnerAfter);
    const settlementJournals = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "JournalTransaction" WHERE "requestId"=$1`,
      [`competition-prize-settlement:${created.competition.id}`]
    );
    expect(settlementJournals[0].n).toBe("1");

    const finished = await admin.getCompetition(created.competition.id);
    expect(finished.status).toBe("FINISHED");
    expect(finished.prizeStatus).toBe("PAID");
    // The winner's available balance reflects both entry and prize economics.
    const expectedWinnerBalance =
      winner.userId === player1.userId
        ? before1 - 10_000_000n + 20_000_000n
        : before2 - 10_000_000n + 20_000_000n;
    expect(winnerAfter).toBe(expectedWinnerBalance);
    await expectLedgerBalanced();
  });

  it("finalizes a real EIP-712 withdrawal through the custody container (receipt + reconciliation)", async () => {
    const winner = winnerUser;
    if (!winner) throw new Error("ASSET settle did not select a winner");

    withdrawalAmount = 30_000_000n;
    const availableBefore = await available(winner);
    expect(availableBefore).toBeGreaterThanOrEqual(withdrawalAmount);
    withdrawalDestination = privateKeyToAccount(generatePrivateKey()).address;

    const intent: WithdrawalIntent = WithdrawalIntentSchema.parse({
      intentId: `pt-prod-accept-wd-${Date.now()}`,
      principalId: winner.userId,
      assetId: ASSET_ID,
      destination: withdrawalDestination.toLowerCase(),
      amountAtomic: bigIntToAtomicAmount(withdrawalAmount),
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3_600,
      chainId: CHAIN_ID,
    });
    const typed = withdrawalIntentTypedData(intent, {
      name: "PokerTools Withdrawal",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: TREASURY,
    });
    const signature = await winner.account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);
    withdrawalSubmission = WithdrawalSubmissionSchema.parse({ intent, signature });
    withdrawalIntentId = intent.intentId;

    const record = await winner.client.submitWithdrawal(withdrawalSubmission);
    expect(record.status).toBe("RESERVED");
    expect(await available(winner)).toBe(availableBefore - withdrawalAmount);
    expect(await pendingWithdrawal(winner)).toBe(withdrawalAmount);

    // The isolated custody container owns signing/broadcast/finality; blocks
    // are mined deterministically until the durable record reaches FINALIZED.
    withdrawalRecordBefore = await waitForWithdrawalFinalized(intent.intentId, 240_000);
    expect(withdrawalRecordBefore.signedRawTx).toBeTruthy();
    expect(withdrawalRecordBefore.payloadHash).toBeTruthy();
    expect(withdrawalRecordBefore.confirmedJournalId).toBeTruthy();
    expect(keccak256(withdrawalRecordBefore.signedRawTx as `0x${string}`)).toBe(
      withdrawalRecordBefore.txHash
    );

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: withdrawalRecordBefore.txHash as `0x${string}`,
    });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(TREASURY);
    expect(await tokenBalance(withdrawalDestination)).toBe(withdrawalAmount);
    const transfers = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === USDC.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase().endsWith(withdrawalDestination.slice(2).toLowerCase())
    );
    expect(transfers).toHaveLength(1);

    expect(await pendingWithdrawal(winner)).toBe(0n);
    expect(await treasuryTokenBalance()).toBe(170_000_000n);
    expect(await expectedTreasuryAtomic()).toBe(170_000_000n);
    await expectLedgerBalanced();
  });

  it("restarts api + custody, preserving the finalized receipt and never paying twice", async () => {
    if (!winnerUser || !withdrawalSubmission || !withdrawalDestination || !withdrawalRecordBefore) {
      throw new Error("The withdrawal test did not complete; restart assertions cannot run");
    }
    const before = withdrawalRecordBefore;
    const destinationBefore = await tokenBalance(withdrawalDestination);
    const previousReconciliation = await sql<{ id: string }>(
      `SELECT id FROM "TreasuryReconciliation" WHERE "assetId"=$1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
      [ASSET_ID]
    );
    const previousReconciliationId = previousReconciliation[0]?.id ?? null;

    await runCompose(["restart", "api", "custody"], { timeoutMs: 120_000 });
    try {
      await waitForApiAfterRestart(180_000);
    } catch (error) {
      await dumpDiagnostics("restart health failure");
      throw error;
    }

    // The restarted custody worker reconciles immediately with the completed
    // ledger. Detect a NEW durable row (never a clock comparison) and require
    // MATCHED with both sides equal to the on-chain and ledger truth.
    let reconciliation: ReconciliationRow | undefined;
    let latestReconciliation: ReconciliationRow | undefined;
    const reconciliationDeadline = Date.now() + 180_000;
    while (Date.now() < reconciliationDeadline) {
      const rows = await sql<ReconciliationRow>(
        `SELECT id,status,"observedAtomic","ledgerAtomic","differenceAtomic","blockNumber",evidence,"createdAt" FROM "TreasuryReconciliation" WHERE "assetId"=$1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
        [ASSET_ID]
      );
      latestReconciliation = rows[0];
      if (latestReconciliation && latestReconciliation.id !== previousReconciliationId) {
        if (latestReconciliation.status === "MATCHED") {
          reconciliation = latestReconciliation;
          break;
        }
        await dumpDiagnostics("post-restart reconciliation mismatch");
        throw new Error(
          `post-restart reconciliation is ${latestReconciliation.status}: ` +
            `observed=${latestReconciliation.observedAtomic} ledger=${latestReconciliation.ledgerAtomic} ` +
            `difference=${latestReconciliation.differenceAtomic}`
        );
      }
      await sleep(1_000);
    }
    if (!reconciliation) {
      await dumpDiagnostics("missing post-restart reconciliation");
      const asset = await sql<{ status: string }>(`SELECT status FROM "Asset" WHERE id=$1`, [
        ASSET_ID,
      ]);
      throw new Error(
        `No new reconciliation row after restart; latest=${JSON.stringify(
          latestReconciliation ?? null
        )} assetStatus=${asset[0]?.status ?? "missing"}`
      );
    }
    expect(reconciliation.differenceAtomic).toBe("0");
    expect(reconciliation.blockNumber).not.toBeNull();
    expect(BigInt(reconciliation.observedAtomic)).toBe(await treasuryTokenBalance());
    expect(BigInt(reconciliation.ledgerAtomic)).toBe(await expectedTreasuryAtomic());
    const evidence = reconciliation.evidence as { observations?: unknown[] } | null;
    expect(Array.isArray(evidence?.observations)).toBe(true);
    expect((evidence?.observations ?? []).length).toBeGreaterThanOrEqual(2);

    // The same signed intent is an idempotent replay: same durable record and
    // txHash, never a new reservation or broadcast. The API container may have
    // been recreated on restart with a new random loopback port, so this uses a
    // fresh client bound to the re-resolved base URL.
    const replayClient = new PokerClient({
      baseUrl: handoff.apiBase,
      token: winnerUser!.token,
      retry: { count: 0 },
    });
    const replay = await replayClient.submitWithdrawal(withdrawalSubmission);
    expect(replay.intentId).toBe(withdrawalIntentId);
    expect(replay.status).toBe("FINALIZED");
    expect(replay.txHash).toBe(before.txHash);
    const records = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "WithdrawalIntentRecord" WHERE "assetId"=$1 AND "principalId"=$2 AND nonce=1`,
      [ASSET_ID, winnerUser!.userId]
    );
    expect(records[0].n).toBe("1");

    // Let the restarted custody worker tick several times: terminal records are
    // never reprocessed and value is never paid twice.
    await sleep(10_000);
    expect(await withdrawalRow(withdrawalIntentId)).toEqual(before);
    expect(await tokenBalance(withdrawalDestination)).toBe(destinationBefore);
    expect(await treasuryTokenBalance()).toBe(170_000_000n);
    expect(await expectedTreasuryAtomic()).toBe(170_000_000n);

    const ready = await waitForFinancialReady(120_000);
    expect(ready.status).toBe("ready");
    expect(ready.financial?.state).toBe("READY");
    await expectLedgerBalanced();
  });
});
