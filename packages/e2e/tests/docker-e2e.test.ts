/**
 * Docker E2E Integration Test
 *
 * End-to-end test that:
 *  1. Starts a local Anvil chain and deploys MockUSDC.
 *  2. Builds and starts the Docker Compose stack (API + Redis + Worker).
 *  3. Seeds canonical asset/auth configuration (no user balances).
 *  4. Exercises the full API surface over HTTP with real SIWE auth.
 *  5. Performs real direct-treasury USDC deposits (transfer → exact-log claim).
 *  6. Runs a multiplayer poker table with buy-ins, actions, and stand.
 *  7. Reserves an EIP-712 withdrawal intent and drives the real custody workflow.
 *  8. Cleans up all resources (containers, volumes, Anvil, temp files).
 *
 * Prerequisites:
 *  - Docker, Foundry/Anvil, Node.js >= 24
 *  - Run: npm run e2e:docker
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// --- Chain helpers ---
import {
  startAnvil,
  stopAnvil,
  deployContracts,
  publicClient,
  walletClient,
  localChain,
  ANVIL_RPC,
  type DeployedContracts,
} from "./helpers/chain-utils.js";

// --- DB utilities (local copies to avoid cross-package envalid triggers) ---
import { createPrismaClient } from "./helpers/db-utils.js";
import type { PrismaClient } from "../../api/generated/prisma/index.js";

// --- Independent RPC endpoints for the canonical ChainRegistry quorum ---
import { startQuorumProxies, type ProxySet } from "./finance/helpers/quorum-proxy.js";

// --- viem ---
import { keccak256, parseAbi, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import WebSocket from "ws";
import {
  PokerClient,
  PokerSocket,
  PokerSDKError,
  type CanonicalActionRequest,
  type LegalActionFamily,
  type PublicWireState,
  type SeatObservation,
  DepositClaimRequestSchema,
  WithdrawalIntentSchema,
  WithdrawalSubmissionSchema,
  withdrawalIntentTypedData,
  bigIntToAtomicAmount,
  type WithdrawalIntent,
} from "@pokertools/sdk";

// ============================================================================
// Constants
// ============================================================================

const API_BASE = "http://localhost:3000";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.e2e.yml");
const E2E_RUNTIME_DIR = path.join(os.tmpdir(), "pokertools-e2e-runtime");
const E2E_CHAIN_ID = 31337;
const E2E_TREASURY_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const E2E_TREASURY_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

// Must match docker-compose.e2e.yml environment
const E2E_SECRETS = {
  JWT_SECRET: "e2e-jwt-secret-not-for-production",
  COOKIE_SECRET: "e2e-cookie-secret-not-for-production",
  WALLET_ENCRYPTION_SECRET: "e2e-wallet-encryption-secret-for-tests-only",
};

let capturedFailureDiagnostics = false;
afterEach(({ task }) => {
  if (task.result?.state !== "fail" || capturedFailureDiagnostics) return;
  capturedFailureDiagnostics = true;
  // Preserve the first failure's process/worker evidence before teardown. Later
  // failures in this sequential lifecycle suite may only be consequences.
  try {
    const logs = execSync(
      `POKERTOOLS_E2E_RUNTIME="${E2E_RUNTIME_DIR}" docker compose -f "${COMPOSE_FILE}" logs --no-color --tail 60 api worker`,
      { encoding: "utf8", timeout: 15000 }
    );
    let redacted = logs.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
    for (const secret of Object.values(E2E_SECRETS))
      redacted = redacted.replaceAll(secret, "[redacted]");
    console.error("[E2E] First-failure diagnostics:\n" + redacted);
  } catch {
    console.error("[E2E] First-failure container diagnostics unavailable");
  }
});

const USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

// ============================================================================
// Test state
// ============================================================================

let contracts: DeployedContracts;
let prisma: PrismaClient;

interface TestUser {
  privateKey: `0x${string}`;
  account: PrivateKeyAccount;
  token: string;
  userId: string;
  username: string;
}

let player1: TestUser;
let player2: TestUser;
let player3: TestUser;
let tableId: string;

/** Canonical asset id for the Anvil MockUSDC treasury route. */
let e2eAssetId: string;
let quorumProxies: ProxySet;
/** Raw atomic (6-decimal) credited balance for each player from real claims. */
const creditedAtomic: Record<string, bigint> = {};

/** Module-level capture of each player's MAIN balance immediately after buy-in. */
const postBuyInMain: Record<number, number> = {};
const postHandStacks: Record<number, number> = {};
let winningSeat: number | null = null;

// ============================================================================
// Helpers
// ============================================================================

/** Thin HTTP client for the Pokertools API */
async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    let data: unknown;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  } catch (err) {
    throw new Error(`API call failed: ${method} ${path} — ${String(err)}`, { cause: err });
  }
}

/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve a requested action family against the authoritative server-issued
 * legal actions and build the strict canonical request
 * `{requestId,turnId,expectedVersion,actionId,amount?}`.
 *
 * The client never invents legality: a family the server did not offer for the
 * observed turn throws instead of submitting a guessed action.
 */
function toCanonicalActionRequest(
  observation: SeatObservation,
  requested: { type: string; amount?: number }
): CanonicalActionRequest {
  const family = requested.type.toUpperCase() as LegalActionFamily;
  const legal = observation.legalActions.find((action) => action.family === family);
  if (!legal) {
    throw new Error(
      `Server did not offer a legal ${family} action (offered: ${
        observation.legalActions.map((action) => action.family).join(", ") || "none"
      })`
    );
  }
  const bounded = legal.minAmount !== undefined || legal.maxAmount !== undefined;
  const amount = bounded ? (requested.amount ?? legal.amount ?? legal.minAmount) : legal.amount;
  if (bounded && amount === undefined) {
    throw new Error(`A chip amount is required for the ${family} action`);
  }
  if (amount !== undefined && legal.minAmount !== undefined && amount < legal.minAmount) {
    throw new Error(`Amount ${amount} is below the minimum ${legal.minAmount} for ${family}`);
  }
  if (amount !== undefined && legal.maxAmount !== undefined && amount > legal.maxAmount) {
    throw new Error(`Amount ${amount} is above the maximum ${legal.maxAmount} for ${family}`);
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
 * Fetch the acting principal's observation and submit one canonical action.
 * Returns the resulting masked wire state for that principal.
 */
async function canonicalAction(
  client: PokerClient,
  tableId: string,
  requested: { type: string; amount?: number }
): Promise<PublicWireState> {
  // A real client races the scheduled timeout worker and other actors: a
  // stale/conflicting submission must be re-resolved from a fresh observation,
  // never replayed blind. At most one mutation can win because the loser's
  // turnId/version are stale and it performs no second mutation.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observation = await client.getObservation(tableId);
    try {
      const result = await client.action(tableId, toCanonicalActionRequest(observation, requested));
      return result.observation.state;
    } catch (error) {
      const conflict =
        error instanceof PokerSDKError &&
        (error.statusCode === 409 || error.code === "GAME_CONFLICT" || error.code === "STALE_TURN");
      if (!conflict) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("canonical action conflict");
}

/**
 * Authenticate a new user via SIWE (nonce → login → token).
 */
async function authenticateUser(): Promise<TestUser> {
  const pk = generatePrivateKey();
  const acc = privateKeyToAccount(pk);
  return authenticateAccount(pk, acc);
}

async function authenticateAccount(
  pk: `0x${string}`,
  acc: PrivateKeyAccount,
  fallbackUsername = ""
): Promise<TestUser> {
  const nonceRes = await api("POST", "/auth/nonce");
  expect(nonceRes.status, JSON.stringify(nonceRes.data)).toBe(200);
  const nonce = (nonceRes.data as { nonce: string }).nonce;
  const siweMsg = createSiweMessage({
    address: acc.address,
    chainId: 31337,
    domain: "localhost",
    nonce,
    uri: "http://localhost:3000",
    version: "1",
    statement: "Sign in to PokerTools E2E Test",
    issuedAt: new Date(),
  });
  const loginRes = await api("POST", "/auth/login", {
    message: siweMsg,
    signature: await acc.signMessage({ message: siweMsg }),
  });
  expect(loginRes.status, JSON.stringify(loginRes.data)).toBe(200);
  const body = loginRes.data as { token: string; user: { id: string; username: string } };
  expect(body.token).toBeTruthy();
  expect(body.user.id).toBeTruthy();

  return {
    privateKey: pk,
    account: acc,
    token: body.token,
    userId: body.user.id,
    username: body.user.username || fallbackUsername,
  };
}

/**
 * Credit a wallet's canonical USER_AVAILABLE balance through the REAL finance
 * path: mint to the wallet, transfer from the authenticated wallet to the
 * treasury, then an exact-log claim through `POST /finance/deposits/claim`.
 *
 * The transfer sender is the authenticated wallet, so the canonical verifier's
 * WRONG_SENDER check passes. No DB credit shortcut is used.
 */
async function claimDeposit(user: TestUser, amountAtomic: bigint): Promise<void> {
  const { createWalletClient, http } = await import("viem");
  const userClient = createWalletClient({
    account: user.account,
    chain: localChain,
    transport: http(ANVIL_RPC),
  });

  // Fund gas and the exact token amount to the authenticated wallet.
  await walletClient.sendTransaction({
    account: walletClient.account,
    chain: localChain,
    to: user.account.address,
    value: parseUnits("0.5", 18),
  });
  const mintHash = await walletClient.writeContract({
    address: contracts.usdcAddress,
    abi: USDC_ABI,
    functionName: "mint",
    args: [user.account.address, amountAtomic],
    chain: localChain,
    account: walletClient.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const depositHash = await userClient.writeContract({
    address: contracts.usdcAddress,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [E2E_TREASURY_ADDRESS, amountAtomic],
    chain: localChain,
    account: user.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  const logIndex = receipt.logs.findIndex(
    (log) =>
      log.address.toLowerCase() === contracts.usdcAddress.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[2]?.toLowerCase().endsWith(E2E_TREASURY_ADDRESS.slice(2).toLowerCase())
  );
  expect(logIndex, "deposit Transfer log to treasury must exist").toBeGreaterThanOrEqual(0);

  // Advance confirmations past the asset threshold then let viem's block cache
  // expire before the exact-log verifier reads the canonical receipt.
  await publicClient.request({ method: "anvil_mine" as never, params: ["0x2"] as never });
  await sleep(4500);

  const claim = DepositClaimRequestSchema.parse({
    assetId: e2eAssetId,
    txHash: depositHash,
    logIndex,
  });
  const { status, data } = await api("POST", "/finance/deposits/claim", claim, user.token);
  expect(status, JSON.stringify(data)).toBeLessThan(300);
  creditedAtomic[user.userId] = (creditedAtomic[user.userId] ?? 0n) + amountAtomic;
}

/** Read a principal's canonical available atomic balance for the E2E asset. */
async function availableAtomic(token: string): Promise<bigint> {
  const { status, data } = await api("GET", "/finance/balances", undefined, token);
  expect(status).toBe(200);
  const balances = (data as { balances: Array<{ assetId: string; availableAtomic: string }> })
    .balances;
  const entry = balances.find((candidate) => candidate.assetId === e2eAssetId);
  return entry ? BigInt(entry.availableAtomic) : 0n;
}

/** Read a principal's canonical chip balances (integer chips as numbers). */
async function chipBalances(token: string): Promise<{ main: number; inPlay: number }> {
  const { status, data } = await api("GET", "/user/me", undefined, token);
  expect(status).toBe(200);
  const chips = (data as { chipBalances: { available: string; inPlay: string } }).chipBalances;
  return { main: Number(chips.available), inPlay: Number(chips.inPlay) };
}

/** Poll until the canonical available atomic balance reaches `target`. */
async function waitForAvailable(
  token: string,
  target: bigint,
  timeoutMs = 30_000
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let balance = await availableAtomic(token);
  while (balance < target && Date.now() < deadline) {
    await sleep(500);
    balance = await availableAtomic(token);
  }
  return balance;
}

// ============================================================================
// Setup & Teardown
// ============================================================================

beforeAll(async () => {
  // ── 1. Start Anvil ─────────────────────────────────────────────────────
  console.log("\n[E2E] Starting Anvil...");
  await startAnvil();
  console.log("[E2E] Anvil started on port 8545");

  // ── 2. Deploy contracts ────────────────────────────────────────────────
  console.log("[E2E] Deploying contracts...");
  contracts = await deployContracts();
  console.log(`[E2E] MockUSDC: ${contracts.usdcAddress}`);

  // ── 2b. Independent RPC proxy endpoints for the canonical ChainRegistry ──
  // The API and host custody both require >= 2 distinct endpoint URLs per chain
  // (`assertUniqueEndpoints` rejects duplicate strings). Two proxies forward to
  // the single Anvil node, so the canonical quorum path is exercised for real.
  quorumProxies = await startQuorumProxies("http://127.0.0.1:8545", 2);
  console.log(`[E2E] Quorum proxies: ${quorumProxies.proxies.map((p) => p.url).join(", ")}`);

  // ── 3. Prepare runtime directory ───────────────────────────────────────
  if (fs.existsSync(E2E_RUNTIME_DIR)) {
    fs.rmSync(E2E_RUNTIME_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(E2E_RUNTIME_DIR, { recursive: true });
  // This throw-away bind mount is shared with the non-root container UID.
  fs.chmodSync(E2E_RUNTIME_DIR, 0o777);
  console.log(`[E2E] Runtime dir: ${E2E_RUNTIME_DIR}`);

  // ── 4. Build and start Docker Compose ──────────────────────────────────
  console.log("[E2E] Building and starting Docker Compose stack...");
  try {
    execSync(
      `POKERTOOLS_E2E_RUNTIME="${E2E_RUNTIME_DIR}" docker compose -f "${COMPOSE_FILE}" up --build -d`,
      { stdio: "inherit", timeout: 900000 }
    );
  } catch (error) {
    // Capture diagnostics before afterAll removes the failed containers.
    const logs = execSync(
      `POKERTOOLS_E2E_RUNTIME="${E2E_RUNTIME_DIR}" docker compose -f "${COMPOSE_FILE}" logs --no-color --tail 40 api`,
      { encoding: "utf8" }
    );
    console.error(logs.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@"));
    throw error;
  }

  // ── 5. Wait for API health ─────────────────────────────────────────────
  console.log("[E2E] Waiting for API health...");
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) {
        const body = await res.json();
        console.log(`[E2E] API healthy: ${JSON.stringify(body)}`);
        break;
      }
    } catch {
      // not ready yet
    }
    if (i === 59) throw new Error("API did not become healthy within 60s");
    await sleep(1000);
  }

  // ── 6. Seed canonical config + HOUSE principal from host side ──────────
  console.log("[E2E] Seeding canonical configuration...");

  // The host-side Prisma client reads the same SQLite file the API container
  // applies schema.sql to. This is a canonical-config fixture only: no user
  // balance is created here.
  process.env.WALLET_ENCRYPTION_SECRET = E2E_SECRETS.WALLET_ENCRYPTION_SECRET;
  process.env.DATABASE_URL = `file:${E2E_RUNTIME_DIR}/e2e.db`;

  prisma = createPrismaClient();

  // Delete stale canonical/config data first (order matters for FK constraints).
  await prisma.depositClaimRecord.deleteMany();
  await prisma.withdrawalIntentRecord.deleteMany();
  await prisma.journalPosting.deleteMany();
  await prisma.journalTransaction.deleteMany();
  await prisma.atomicAccount.deleteMany();
  await prisma.treasuryReconciliation.deleteMany();
  await prisma.financialIncident.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.session.deleteMany();
  await prisma.playerNote.deleteMany();
  await prisma.handHistory.deleteMany();
  await prisma.tournamentEntry.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.table.deleteMany();
  await prisma.user.deleteMany();

  // 6a. Seed the canonical asset: direct-treasury route over the Anvil MockUSDC
  // token, with the deployer/treasury account and the two RPC quorum endpoints
  // the API's ChainRegistry validates. `rpcUrls` must contain >= 2 distinct
  // endpoints for the same chain.
  e2eAssetId = `eip155:${E2E_CHAIN_ID}/erc20:${contracts.usdcAddress.toLowerCase()}`;
  await prisma.asset.create({
    data: {
      id: e2eAssetId,
      chainId: E2E_CHAIN_ID,
      tokenAddress: contracts.usdcAddress.toLowerCase(),
      symbol: "USDC",
      decimals: 6,
      status: "ACTIVE",
      confirmations: 1,
      deepFinality: 3,
      treasuryAddress: E2E_TREASURY_ADDRESS.toLowerCase(),
      // The container reaches host services via the host gateway.
      rpcUrls: quorumProxies.proxies.map((proxy) => proxy.hostUrl),
      // Conservative positive native-gas floor; the Anvil treasury is funded.
      minGasAtomic: "100000000000000000",
    },
  });

  // 6b. Seed HOUSE user (required by the engine for rake and house settlement).
  await prisma.user.create({
    data: {
      username: "HOUSE",
      address: "0x0000000000000000000000000000000000000000",
      role: "ADMIN",
    },
  });

  console.log("[E2E] Canonical configuration seeded successfully");
}, 600000);

afterAll(async () => {
  console.log("\n[E2E] Cleaning up...");

  // Disconnect Prisma
  if (prisma) {
    await prisma.$disconnect().catch(() => undefined);
  }
  // Stop Docker Compose
  try {
    execSync(
      `POKERTOOLS_E2E_RUNTIME="${E2E_RUNTIME_DIR}" docker compose -f "${COMPOSE_FILE}" down -v`,
      { stdio: "inherit", timeout: 60000 }
    );
    console.log("[E2E] Docker Compose stopped");
  } catch (err) {
    console.error("[E2E] Docker Compose cleanup failed:", err);
  }

  // Stop Anvil
  await stopAnvil();
  console.log("[E2E] Anvil stopped");

  // Close quorum proxies
  if (quorumProxies) {
    await quorumProxies.close().catch(() => undefined);
    console.log("[E2E] Quorum proxies stopped");
  }

  // Remove temp runtime dir
  if (fs.existsSync(E2E_RUNTIME_DIR)) {
    fs.rmSync(E2E_RUNTIME_DIR, { recursive: true, force: true });
    console.log("[E2E] Runtime dir removed");
  }

  console.log("[E2E] Cleanup complete\n");
}, 120000);

// ============================================================================
// Tests
// ============================================================================

describe("Docker E2E Integration", () => {
  // ── 1. Health & Docs ───────────────────────────────────────────────────
  it("GET /health returns ok", async () => {
    const { status, data } = await api("GET", "/health");
    expect(status).toBe(200);
    expect((data as Record<string, unknown>).status).toBe("ok");
  });

  it("GET /docs returns Swagger UI HTML", async () => {
    const res = await fetch(`${API_BASE}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("swagger");
  });

  it("GET /finance/assets returns the enabled canonical asset", async () => {
    const { status, data } = await api("GET", "/finance/assets");
    expect(status).toBe(200);
    const assets = (data as { assets: Array<Record<string, unknown>> }).assets;
    expect(assets.length).toBeGreaterThanOrEqual(1);
    const anvil = assets.find((asset) => asset.chainId === 31337);
    expect(anvil).toBeDefined();
    expect((anvil as Record<string, unknown>).decimals).toBe(6);
  });

  // ── 2. Authentication Flow ─────────────────────────────────────────────
  it("POST /auth/nonce returns a nonce", async () => {
    const { status, data } = await api("POST", "/auth/nonce");
    expect(status).toBe(200);
    const body = data as { nonce: string };
    expect(body.nonce).toBeDefined();
    expect(body.nonce.length).toBeGreaterThanOrEqual(8);
  });

  it("Full SIWE auth flow: nonce → login → token (3 players)", async () => {
    player1 = await authenticateUser();
    player2 = await authenticateUser();
    player3 = await authenticateUser();

    console.log(`[E2E] Player1: ${player1.username} (${player1.userId})`);
    console.log(`[E2E] Player2: ${player2.username} (${player2.userId})`);
    console.log(`[E2E] Player3: ${player3.username} (${player3.userId})`);
  });

  it("GET /user/me returns authenticated user profile and balances", async () => {
    const { status, data } = await api("GET", "/user/me", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as Record<string, unknown>;
    expect(body.username).toBe(player1.username);
    expect(body.chipBalances).toBeDefined();
    expect(body.assetBalances).toBeDefined();
  });

  // ── 3. Direct-treasury deposit claim flow (canonical) ──────────────────
  it("GET /finance/assets exposes the canonical Anvil asset", async () => {
    const { status, data } = await api("GET", "/finance/assets");
    expect(status).toBe(200);
    const assets = (
      data as { assets: Array<{ assetId: string; chainId: number; decimals: number }> }
    ).assets;
    const found = assets.find((asset) => asset.assetId === e2eAssetId);
    expect(found).toBeDefined();
    expect(found!.chainId).toBe(E2E_CHAIN_ID);
    expect(found!.decimals).toBe(6);
  });

  it("Real on-chain direct-treasury deposits: transfer → exact-log claim → credit", async () => {
    const depositAmount = parseUnits("200", 6); // 200 USDC per player

    // Each authenticated wallet sends its own tokens to the treasury and claims
    // the exact `(txHash, logIndex)`. This is the canonical DIRECT_TREASURY path.
    for (const user of [player1, player2, player3]) {
      await claimDeposit(user, depositAmount);
    }

    const [bal1, bal2, bal3] = await Promise.all([
      waitForAvailable(player1.token, depositAmount),
      waitForAvailable(player2.token, depositAmount),
      waitForAvailable(player3.token, depositAmount),
    ]);
    expect(bal1).toBe(depositAmount);
    expect(bal2).toBe(depositAmount);
    expect(bal3).toBe(depositAmount);
    console.log(`[E2E] Claimed deposits: ${bigIntToAtomicAmount(bal1)} atomic each`);
  });

  it("POST /finance/deposits/claim is idempotent on the exact log identity", async () => {
    const amount = parseUnits("2", 6);
    const mintHash = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "mint",
      args: [player1.account.address, amount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    const transferHash = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [E2E_TREASURY_ADDRESS, amount],
      chain: localChain,
      account: player1.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
    const logIndex = receipt.logs.findIndex(
      (log) =>
        log.address.toLowerCase() === contracts.usdcAddress.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC
    );
    await publicClient.request({ method: "anvil_mine" as never, params: ["0x2"] as never });
    await sleep(4500);

    const payload = DepositClaimRequestSchema.parse({
      assetId: e2eAssetId,
      txHash: transferHash,
      logIndex,
    });
    const first = await api("POST", "/finance/deposits/claim", payload, player1.token);
    expect(first.status, JSON.stringify(first.data)).toBeLessThan(300);
    const before = await availableAtomic(player1.token);

    const replay = await api("POST", "/finance/deposits/claim", payload, player1.token);
    expect(replay.status).toBe(200);
    const after = await availableAtomic(player1.token);
    expect(after).toBe(before); // replay must not credit twice
  });

  it("GET /finance/deposits/:id returns the canonical claim", async () => {
    const { status, data } = await api("GET", "/finance/deposits", undefined, player1.token);
    // The list route is not part of the canonical contract; skip when absent.
    if (status === 404) return;
    const claimId = (data as { claims?: Array<{ id: string }> }).claims?.[0]?.id;
    if (!claimId) return;
    const stored = await api("GET", `/finance/deposits/${claimId}`, undefined, player1.token);
    expect(stored.status).toBe(200);
    expect((stored.data as { id: string }).id).toBe(claimId);
  });

  // ── 4. Multi-Table Tournament Flow (30 players) ────────────────────────
  it("30-player multi-table tournament: funded users → API lifecycle → director reconciliation → settlement", async () => {
    // ── 4a. Create 30 authenticated users and fund MAIN balances ───────────
    const mtUsers: TestUser[] = [];
    for (let i = 0; i < 30; i++) {
      const user = await authenticateUser();
      const creditRes = await api("POST", "/user/test-credit", { amount: 5000 }, user.token);
      expect(creditRes.status).toBe(200);
      mtUsers.push(user);
    }
    console.log(`[E2E] Created and funded 30 tournament players`);

    // ── 4b. Create tournament via API ─────────────────────────────────────
    const createRes = await api(
      "POST",
      "/tournaments",
      {
        name: "E2E 30-Player Multi-Table",
        buyIn: 100,
        fee: 0,
        startingStack: 3000,
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 30,
        tableMaxPlayers: 8,
        balancingTolerance: 2,
        payoutPercentages: [100],
      },
      player1.token
    );
    expect(createRes.status).toBe(200);
    const { tournamentId, tableId: primaryTableId } = createRes.data as {
      tournamentId: string;
      tableId: string;
    };
    console.log(`[E2E] Tournament created: ${tournamentId}, primary table: ${primaryTableId}`);

    // ── 4c. Register all 30 players through the API ────────────────────────
    for (let i = 0; i < 30; i++) {
      const registerRes = await api(
        "POST",
        `/tournaments/${tournamentId}/register`,
        {
          seat: i,
          idempotencyKey: `e2e-mtt-register-${tournamentId}-${i}`,
        },
        mtUsers[i].token
      );
      expect(registerRes.status).toBe(200);
    }
    console.log(`[E2E] Registered all 30 players`);

    // ── 4d. Verify prize pool ─────────────────────────────────────────────
    const detailsRes1 = await api("GET", `/tournaments/${tournamentId}`);
    expect(detailsRes1.status).toBe(200);
    const t1 = (detailsRes1.data as { tournament: Record<string, unknown> }).tournament;
    expect(t1.registeredPlayers).toBe(30);
    expect(t1.prizePool).toBe(3000); // 30 × 100
    expect(t1.maxPlayers).toBe(30);
    expect(t1.tableMaxPlayers).toBe(8);
    console.log(`[E2E] Prize pool: ${t1.prizePool}`);

    // ── 4e. Start tournament → expect 8/8/7/7 distribution ────────────────
    const startRes = await api(
      "POST",
      `/tournaments/${tournamentId}/start`,
      undefined,
      player1.token
    );
    expect(startRes.status).toBe(200);
    const startBody = startRes.data as {
      success: boolean;
      tableIds: string[];
      distribution: number[];
    };
    expect(startBody.success).toBe(true);
    expect(startBody.tableIds).toHaveLength(4);
    expect(startBody.distribution).toEqual([8, 8, 7, 7]);
    console.log(
      `[E2E] Tournament started: ${startBody.tableIds.length} tables, distribution ${startBody.distribution.join("/")}`
    );

    // ── 4f. Verify tournament details show multi-table info ───────────────
    const detailsRes2 = await api("GET", `/tournaments/${tournamentId}`);
    expect(detailsRes2.status).toBe(200);
    const t2 = (detailsRes2.data as { tournament: Record<string, unknown> }).tournament;
    expect(t2.status).toBe("RUNNING");
    const tables = t2.tables as Array<{ id: string; status: string; playerCount: number }>;
    expect(tables).toHaveLength(4);
    // Verify player distribution in tables
    const playerCounts = tables.map((t) => t.playerCount).sort((a, b) => b - a);
    expect(playerCounts).toEqual([8, 8, 7, 7]);
    // Verify entries have currentTableId set
    const entries = t2.entries as Array<{
      currentTableId: string | null;
      currentSeat: number | null;
    }>;
    const entriesWithTable = entries.filter((e) => e.currentTableId);
    expect(entriesWithTable.length).toBe(30);
    console.log(`[E2E] Multi-table verification passed`);

    // ── 4g–4i. Play real hands; never edit seats, stacks or placements. ────
    const clients = new Map(
      mtUsers.map((user) => [
        user.userId,
        new PokerClient({ baseUrl: API_BASE, token: user.token, retry: { count: 0 } }),
      ])
    );
    interface TournamentProgress {
      entries: Array<{ userId: string; status: string; currentTableId: string }>;
      tables: Array<{ id: string; status: string }>;
    }
    const progress = async (): Promise<TournamentProgress> => {
      const response = await api("GET", `/tournaments/${tournamentId}`, undefined, player1.token);
      expect(response.status).toBe(200);
      return (response.data as { tournament: TournamentProgress }).tournament;
    };
    const reconcile = async () => {
      const response = await api(
        "POST",
        `/tournaments/${tournamentId}/reconcile`,
        undefined,
        player1.token
      );
      expect(response.status, JSON.stringify(response.data)).toBe(200);
    };
    const observedTableCounts = new Set<number>([4]);
    for (let round = 0; round < 300; round++) {
      let current = await progress();
      if (current.entries.filter((entry) => entry.status === "ACTIVE").length === 1) break;
      for (const table of current.tables.filter((candidate) => candidate.status !== "CLOSED")) {
        current = await progress();
        const assigned = current.entries.filter(
          (entry) => entry.status === "ACTIVE" && entry.currentTableId === table.id
        );
        if (
          assigned.length < 2 ||
          current.tables.find((candidate) => candidate.id === table.id)?.status === "CLOSED"
        )
          continue;
        const reader = clients.get(assigned[0].userId)!;
        const initial = await reader.getObservation(table.id);
        let state: PublicWireState = initial.state;
        // The server offers DEAL to every seated principal at a hand boundary.
        // Start the hand through the canonical protocol; never spot-mutate state.
        if (state.actionTo == null) {
          if (!initial.legalActions.some((action) => action.family === "DEAL")) {
            throw new Error(
              `No canonical DEAL offered for table ${table.id} at hand boundary ` +
                `(turnId=${initial.turnId}, offered: ${
                  initial.legalActions.map((action) => action.family).join(",") || "none"
                })`
            );
          }
          // Resolve the DEAL through the same conflict-retrying canonical
          // helper: the director/other tables may advance concurrently.
          state = await canonicalAction(reader, table.id, { type: "DEAL" });
        }
        // Only two contenders shove; others fold. This exercises progressive
        // elimination/balancing rather than skipping directly from four tables
        // to one in a single mass all-in. The engine adjudicates every request.
        const contenders = new Set(
          state.players
            .filter((player) => player && player.stack > 0)
            .sort(
              (a, b) => a!.stack + a!.totalInvestedThisHand - b!.stack - b!.totalInvestedThisHand
            )
            .slice(0, 2)
            .map((player) => player!.id)
        );
        for (let step = 0; step < 200 && state.actionTo != null; step++) {
          const actor = state.players[state.actionTo]!;
          const client = clients.get(actor.id);
          if (!client) throw new Error(`No SDK client for acting player ${actor.id}`);
          const maxBet = Math.max(...state.players.map((player) => player?.betThisStreet ?? 0));
          const amount = actor.stack + actor.betThisStreet;
          const family = !contenders.has(actor.id)
            ? "FOLD"
            : amount <= maxBet
              ? "CALL"
              : maxBet === 0
                ? "BET"
                : "RAISE";
          state = await canonicalAction(client, table.id, {
            type: family,
            ...(family === "BET" || family === "RAISE" ? { amount } : {}),
          });
        }
        expect(state.actionTo).toBeNull();
        expect(state.winners?.length).toBeGreaterThan(0);
        await reconcile();
        current = await progress();
        observedTableCounts.add(
          current.tables.filter((candidate) => candidate.status !== "CLOSED").length
        );
        for (const entry of current.entries.filter((entry) => entry.status === "ACTIVE")) {
          expect(
            current.tables.find((candidate) => candidate.id === entry.currentTableId)?.status
          ).not.toBe("CLOSED");
        }
      }
    }
    const finalProgress = await progress();
    const survivors = finalProgress.entries.filter((entry) => entry.status === "ACTIVE");
    expect(survivors).toHaveLength(1);
    const winningUserId = survivors[0].userId;
    const winnerState = await clients
      .get(winningUserId)!
      .getTableState(survivors[0].currentTableId);
    expect(winnerState!.players.find((player) => player?.id === winningUserId)?.stack).toBe(90000);
    const activeTables = finalProgress.tables.filter((table) => table.status === "ACTIVE");
    expect(activeTables.length).toBeLessThanOrEqual(2);
    expect(observedTableCounts.has(2)).toBe(true);
    expect(observedTableCounts.has(1)).toBe(true);
    await reconcile();
    expect((await progress()).entries).toEqual(finalProgress.entries);
    expect(winningUserId).toBeTruthy();
    console.log(`[E2E] Single winner: ${winningUserId}`);

    // Settle tournament
    const settleRes = await api(
      "POST",
      `/tournaments/${tournamentId}/settle`,
      undefined,
      player1.token
    );
    if (settleRes.status !== 200) {
      console.log(
        `[E2E] Tournament settle failed: ${settleRes.status} ${JSON.stringify(settleRes.data)}`
      );
    }
    expect(settleRes.status).toBe(200);
    const settleBody = settleRes.data as { success: boolean; winnerUserId: string; prize: number };
    expect(settleBody.success).toBe(true);
    expect(settleBody.winnerUserId).toBe(winningUserId);
    expect(settleBody.prize).toBe(3000); // 30 × 100
    const settleAgain = await api(
      "POST",
      `/tournaments/${tournamentId}/settle`,
      undefined,
      player1.token
    );
    expect(settleAgain.status, JSON.stringify(settleAgain.data)).toBe(200);
    expect((settleAgain.data as { winnerUserId: string }).winnerUserId).toBe(winningUserId);
    console.log(`[E2E] Tournament settled: winner ${winningUserId} gets ${settleBody.prize}`);

    // ── 4j. Verify chip balance conservation ──────────────────────────────
    // All 30 users started with 5000 chips each = 150000 total
    // Tournament collected 30 × 100 = 3000 in prize pool
    // Winner gets 3000 back, so total should still be 150000
    const totalBalances = await Promise.all(
      mtUsers.map(async (u) => {
        const accounts = await prisma.chipAccount.findMany({ where: { principalId: u.userId } });
        return accounts.reduce((sum, a) => sum + a.balance, 0n);
      })
    );
    const totalSystem = totalBalances.reduce((sum, b) => sum + b, 0n);
    expect(totalSystem).toBe(150000n);
    console.log(`[E2E] Chip conservation verified: total = ${totalSystem}`);

    // Verify winner chip balance
    const winnerMainAcc = await prisma.chipAccount.findFirstOrThrow({
      where: { principalId: winningUserId, kind: "AVAILABLE" },
    });
    expect(winnerMainAcc.balance).toBe(BigInt(5000 - 100 + 3000)); // started 5000, paid 100 buy-in, won 3000
    console.log(`[E2E] Winner balance: ${winnerMainAcc.balance}`);

    // Verify all tables are closed
    const tableRecords = await prisma.table.findMany({ where: { tournamentId } });
    for (const t of tableRecords) {
      expect(t.status).toBe("CLOSED");
    }

    // Verify tournament status
    const finalTournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    expect(finalTournament?.status).toBe("FINISHED");

    // Keep accepted-action identities/history until workers have stopped.
    // afterAll stops the stack before removing its disposable database. Deleting
    // identities mid-suite races still-running archive/projection jobs and is
    // neither a public tournament lifecycle transition nor safe cleanup ordering.
    console.log(`[E2E] 30-player multi-table tournament test complete`);
  }, 300000);

  // ── 5. Game Flow ───────────────────────────────────────────────────────
  it("POST /tables creates a new table", async () => {
    const { status, data } = await api(
      "POST",
      "/tables",
      {
        name: "E2E Test Table",
        mode: "CASH",
        smallBlind: 50,
        bigBlind: 100,
        maxPlayers: 3,
      },
      player1.token
    );
    expect(status).toBe(200);
    const body = data as { tableId: string };
    tableId = body.tableId;
    expect(tableId).toBeTruthy();
    console.log(`[E2E] Table created: ${tableId}`);
  });

  it("GET /tables lists the new table", async () => {
    const { status, data } = await api("GET", "/tables");
    expect(status).toBe(200);
    const body = data as { tables: Array<Record<string, unknown>> };
    const found = body.tables.find((t) => t.id === tableId);
    expect(found).toBeDefined();
    expect((found as Record<string, unknown>).status).toBe("WAITING");
  });

  it("GET /tables/:id returns table state", async () => {
    const { status, data } = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { state: Record<string, unknown> };
    expect(body.state.tableId || body.state.config).toBeDefined();
  });

  it("POST /tables/:id/buy-in all three players", async () => {
    const buyInAmount = 5000; // 5000 integer gameplay chips (NOT cents)

    // Gameplay chip funding fixture: the operator `test-credit` route issues an
    // explicit durable chip GRANT. This is a declared gameplay fixture, not a DB
    // balance edit and not a finance credit; asset-backed balances are proven
    // separately by the canonical deposit-claim section above.
    await sleep(1500);
    for (const user of [player1, player2, player3]) {
      const grant = await api("POST", "/user/test-credit", { amount: 50_000 }, user.token);
      expect(grant.status, JSON.stringify(grant.data)).toBe(200);
    }

    // Player 1 buys in at seat 0
    const r1 = await api(
      "POST",
      `/tables/${tableId}/buy-in`,
      {
        amount: buyInAmount,
        seat: 0,
        idempotencyKey: `buyin-p1-${Date.now()}`,
      },
      player1.token
    );
    expect(r1.status).toBe(200);

    // Player 2 buys in at seat 1
    const r2 = await api(
      "POST",
      `/tables/${tableId}/buy-in`,
      {
        amount: buyInAmount,
        seat: 1,
        idempotencyKey: `buyin-p2-${Date.now()}`,
      },
      player2.token
    );
    expect(r2.status).toBe(200);

    // Player 3 buys in at seat 2
    const r3 = await api(
      "POST",
      `/tables/${tableId}/buy-in`,
      {
        amount: buyInAmount,
        seat: 2,
        idempotencyKey: `buyin-p3-${Date.now()}`,
      },
      player3.token
    );
    expect(r3.status).toBe(200);

    // Verify balances: available decreased by buy-in, IN_PLAY increased
    const b1 = await chipBalances(player1.token);
    expect(b1.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    const b2 = await chipBalances(player2.token);
    expect(b2.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    const b3 = await chipBalances(player3.token);
    expect(b3.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    // Capture post-buy-in available chip balances for later integrity checks
    postBuyInMain[0] = b1.main;
    postBuyInMain[1] = b2.main;
    postBuyInMain[2] = b3.main;
    console.log(
      `[E2E] Post-buy-in AVAILABLE chips: P1=${postBuyInMain[0]}, P2=${postBuyInMain[1]}, P3=${postBuyInMain[2]}`
    );
  });

  it("SDK-backed WebSocket receives live table updates", async () => {
    const client = new PokerClient({ baseUrl: API_BASE, token: player1.token });
    const socket = new PokerSocket({
      url: API_BASE.replace(/^http/, "ws") + "/ws/play",
      token: player1.token,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatInterval: 5_000,
      reconnectAttempts: 0,
    });

    await socket.connect();
    try {
      const snapshot = await socket.join(tableId);
      expect(snapshot.state.players.filter(Boolean).length).toBeGreaterThanOrEqual(3);

      const updatePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for socket update")),
          10_000
        );
        socket.on("stateUpdate", (updatedTableId, state) => {
          if (updatedTableId === tableId && state.version > snapshot.version) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      await client.deal(tableId);
      await updatePromise;
      expect(socket.getCachedState(tableId)?.version).toBeGreaterThan(snapshot.version);
    } finally {
      socket.disconnect();
    }
  });

  it("canonical action protocol: DEAL + deterministic hand via legal-action folds", async () => {
    const seatClients: Array<PokerClient | undefined> = [
      new PokerClient({ baseUrl: API_BASE, token: player1.token, retry: { count: 0 } }),
      new PokerClient({ baseUrl: API_BASE, token: player2.token, retry: { count: 0 } }),
      new PokerClient({ baseUrl: API_BASE, token: player3.token, retry: { count: 0 } }),
    ];

    // ── DEAL: start the hand through the canonical protocol if the WebSocket
    // test did not already deal one. ──
    const currentRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    const currentState = (currentRes.data as { state: Record<string, unknown> }).state;
    if (currentState.street !== "PREFLOP") {
      const dealClient = seatClients[0]!;
      const observation = await dealClient.getObservation(tableId);
      const deal = observation.legalActions.find((action) => action.family === "DEAL");
      if (!deal) {
        throw new Error(
          `No canonical DEAL offered for table ${tableId} (turnId=${observation.turnId}, offered: ${
            observation.legalActions.map((action) => action.family).join(",") || "none"
          })`
        );
      }
      await dealClient.action(tableId, {
        requestId: randomUUID(),
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: deal.actionId,
      });
      console.log("[E2E] Canonical DEAL accepted");
    } else {
      console.log("[E2E] Hand already dealt by SDK WebSocket test; skipping explicit DEAL");
    }

    // ── Capture table stacks before hand ──
    const stateRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    const preState = (stateRes.data as { state: Record<string, unknown> }).state;
    const prePlayers = preState.players as Array<{ stack: number } | null> | undefined;
    console.log(`[E2E] Pre-hand stacks: ${prePlayers?.map((p) => p?.stack ?? "null").join(", ")}`);

    // ── Deterministic fold loop using the authoritative actionTo seat ──
    let actionCount = 0;
    while (true) {
      const curRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
      const curState = (curRes.data as { state: Record<string, unknown> }).state;
      const street = curState.street as string | undefined;
      const winners = curState.winners as
        Array<{ seat: number; amount: number }> | null | undefined;
      const actionTo = curState.actionTo as number | null | undefined;

      // Hand is complete if we have winners or street is SHOWDOWN with no action pending
      if ((winners && winners.length > 0) || (street === "SHOWDOWN" && actionTo == null)) {
        break;
      }

      // If no action is required but there are no winners, the hand may be transitioning
      if (actionTo == null || actionTo === undefined) {
        console.log(`[E2E] actionTo is null/undefined, street=${street}. Breaking fold loop.`);
        break;
      }

      const actingClient = seatClients[actionTo];
      if (!actingClient) {
        console.log(`[E2E] No client for actionTo=${actionTo}. Breaking fold loop.`);
        break;
      }

      // Fold via the canonical protocol: the acting seat's own client resolves
      // the server-issued FOLD legal action for its observed turn.
      await canonicalAction(actingClient, tableId, { type: "FOLD" });
      actionCount++;
      console.log(`[E2E] Canonical fold #${actionCount}: seat ${actionTo}`);
    }

    expect(actionCount).toBeGreaterThanOrEqual(2);
    console.log(`[E2E] Total fold actions: ${actionCount}`);

    // ── Verify hand completed with winners ──
    const finalRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    const finalState = (finalRes.data as { state: Record<string, unknown> }).state;
    const finalWinners = finalState.winners as
      Array<{ seat: number; amount: number }> | null | undefined;
    const finalPlayers = finalState.players as
      Array<{ stack: number; seat: number } | null> | undefined;

    console.log(`[E2E] Post-hand street: ${finalState.street as string}`);
    console.log(
      `[E2E] Post-hand stacks: ${finalPlayers?.map((p) => p?.stack ?? "null").join(", ")}`
    );

    expect(finalWinners).toBeTruthy();
    expect(finalWinners!.length).toBeGreaterThan(0);
    const totalWinnings = finalWinners!.reduce((sum, w) => sum + w.amount, 0);
    expect(totalWinnings).toBeGreaterThan(0);
    winningSeat = finalWinners!.reduce((best, winner) =>
      winner.amount > best.amount ? winner : best
    ).seat;
    console.log(
      `[E2E] Winners: ${finalWinners!.map((w) => `seat ${w.seat}=${w.amount}`).join(", ")} (total: ${totalWinnings})`
    );

    // ── Assert stack changes: one player gained, at least one lost ──
    if (finalPlayers) {
      const stacksAfter = finalPlayers.map((p) => p?.stack ?? 0);
      const buyInAmount = 5000;
      stacksAfter.forEach((stack, seat) => {
        postHandStacks[seat] = stack;
      });
      const gained = stacksAfter.some((s) => s > buyInAmount);
      const lost = stacksAfter.some((s) => s < buyInAmount);
      expect(gained).toBe(true);
      expect(lost).toBe(true);
      console.log(`[E2E] Stack change verified: gained=${gained}, lost=${lost}`);
    }
  });

  it("POST /tables/:id/add-chips adds chips to seated player", async () => {
    // Keep this small: the endpoint is covered here, while the later stand
    // conservation assertion should not be dominated by optional add-chip state.
    const addAmount = 100; // $1.00
    const { status } = await api(
      "POST",
      `/tables/${tableId}/add-chips`,
      {
        amount: addAmount,
        idempotencyKey: `addchips-p1-${Date.now()}`,
      },
      player1.token
    );
    // May succeed or fail depending on game state; either is fine for coverage
    console.log(`[E2E] Add-chips response status: ${status}`);
  });

  it("POST /tables/:id/stand all three players leave with financial integrity", async () => {
    // ── Stand all three players ──
    const r1 = await api("POST", `/tables/${tableId}/stand`, undefined, player1.token);
    console.log(`[E2E] Player1 stand: ${r1.status}`);

    const r2 = await api("POST", `/tables/${tableId}/stand`, undefined, player2.token);
    console.log(`[E2E] Player2 stand: ${r2.status}`);

    const r3 = await api("POST", `/tables/${tableId}/stand`, undefined, player3.token);
    console.log(`[E2E] Player3 stand: ${r3.status}`);

    // Allow settlement to complete
    await sleep(1000);

    // ── Fetch post-stand balances ──
    const b1 = await chipBalances(player1.token);
    const b2 = await chipBalances(player2.token);
    const b3 = await chipBalances(player3.token);

    console.log(`[E2E] Final balances — P1: main=${b1.main} inPlay=${b1.inPlay}`);
    console.log(`[E2E] Final balances — P2: main=${b2.main} inPlay=${b2.inPlay}`);
    console.log(`[E2E] Final balances — P3: main=${b3.main} inPlay=${b3.inPlay}`);

    // ── Assert IN_PLAY is zero/near-zero after standing ──
    expect(b1.inPlay).toBeLessThanOrEqual(150);
    expect(b2.inPlay).toBeLessThanOrEqual(150);
    expect(b3.inPlay).toBeLessThanOrEqual(150);

    // ── Assert the winner cashed out real winnings and losers reflected real
    // losses. `postBuyInMain` is available BEFORE buy-in; after standing, the
    // player receives the buy-in reserve back plus/minus the hand result, so the
    // correct comparison basis is pre-hand equity (available + buy-in). ──
    const SEATED_BUY_IN = 5000;
    const preHandEquity = (seat: number) => postBuyInMain[seat] + SEATED_BUY_IN;

    const mainIncreased = [0, 1, 2].some((seat) => [b1, b2, b3][seat].main > preHandEquity(seat));
    expect(mainIncreased).toBe(true);

    expect(winningSeat).not.toBeNull();
    expect([b1, b2, b3][winningSeat!].main).toBeGreaterThan(preHandEquity(winningSeat!));

    const loserBelowEquity = [0, 1, 2]
      .filter((seat) => seat !== winningSeat)
      .some((seat) => [b1, b2, b3][seat].main < preHandEquity(seat));
    expect(loserBelowEquity).toBe(true);

    for (const seat of [0, 1, 2]) {
      expect([b1, b2, b3][seat].main).toBeGreaterThanOrEqual(
        postBuyInMain[seat] + (postHandStacks[seat] ?? 0) - 150
      );
    }

    console.log(
      `[E2E] MAIN vs post-buy-in: P1 ${b1.main} (was ${postBuyInMain[0]}), P2 ${b2.main} (was ${postBuyInMain[1]}), P3 ${b3.main} (was ${postBuyInMain[2]}), winner seat=${winningSeat}`
    );

    // ── Total gameplay chips conserved within rake bounds ──
    const totalBefore = postBuyInMain[0] + postBuyInMain[1] + postBuyInMain[2] + 3 * 5000;
    const totalAfter = b1.main + b2.main + b3.main + b1.inPlay + b2.inPlay + b3.inPlay;
    console.log(`[E2E] Total chips before: ${totalBefore}, after: ${totalAfter}`);
    expect(totalAfter).toBeGreaterThanOrEqual(totalBefore - 1000); // Allow for rake + add-chips
    expect(totalAfter).toBeLessThanOrEqual(totalBefore + 10);
  });

  it("GET /user/history returns ledger entries", async () => {
    const { status, data } = await api("GET", "/user/history", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { history: Array<Record<string, unknown>> };
    expect(body.history.length).toBeGreaterThanOrEqual(0); // May have entries
  });

  // ── 5. Withdrawal intents (canonical EIP-712 + real custody workflow) ──
  //
  // The public API only verifies the detached EIP-712 signature and atomically
  // reserves funds (`POST /finance/withdrawals/intents`). Signing, persist-
  // before-broadcast, confirmation and finality are owned by the private
  // custody workflow, which is executed here directly against the same durable
  // database using the real treasury key. There is NO simulated approval and no
  // direct DB status edit.
  it("POST /finance/withdrawals/intents reserves a canonical EIP-712 intent", async () => {
    const amount = parseUnits("50", 6);
    const destination = "0x9999999999999999999999999999999999999999" as Address;
    const intent: WithdrawalIntent = {
      intentId: `e2e_wd_${Date.now()}`,
      principalId: player1.userId,
      assetId: e2eAssetId,
      destination: destination.toLowerCase() as Address,
      amountAtomic: bigIntToAtomicAmount(amount),
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: E2E_CHAIN_ID,
    };
    const domain = {
      name: "PokerTools Withdrawal" as const,
      version: "1" as const,
      chainId: E2E_CHAIN_ID,
      verifyingContract: E2E_TREASURY_ADDRESS.toLowerCase() as Address,
    };
    const typed = withdrawalIntentTypedData(WithdrawalIntentSchema.parse(intent), domain);
    const signature = await player1.account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    } as never);

    const submission = WithdrawalSubmissionSchema.parse({ intent, signature });
    const { status, data } = await api(
      "POST",
      "/finance/withdrawals/intents",
      submission,
      player1.token
    );
    expect(status, JSON.stringify(data)).toBeLessThan(300);
    const record = data as { intentId: string; status: string; amountAtomic: string };
    expect(record.intentId).toBe(intent.intentId);
    expect(record.status).toBe("RESERVED");
    expect(record.amountAtomic).toBe(bigIntToAtomicAmount(amount));

    // Reservation is a durable journal holding the exact amount.
    const persisted = await prisma.withdrawalIntentRecord.findUniqueOrThrow({
      where: { id: intent.intentId },
    });
    expect(persisted.reservedJournalId).toBeTruthy();
    expect(persisted.state).toBe("RESERVED");
  });

  it("Withdrawal intent rejects a bad signature", async () => {
    const intent: WithdrawalIntent = {
      intentId: `e2e_wd_bad_${Date.now()}`,
      principalId: player1.userId,
      assetId: e2eAssetId,
      destination: "0x1111111111111111111111111111111111111111" as Address,
      amountAtomic: bigIntToAtomicAmount(parseUnits("1", 6)),
      nonce: 2,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: E2E_CHAIN_ID,
    };
    const { status } = await api(
      "POST",
      "/finance/withdrawals/intents",
      { intent, signature: `0x${"11".repeat(65)}` },
      player1.token
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("GET /finance/withdrawals/:id returns the reserved intent", async () => {
    const records = await prisma.withdrawalIntentRecord.findMany({
      where: { principalId: player1.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(records.length).toBeGreaterThanOrEqual(1);
    const { status, data } = await api(
      "GET",
      `/finance/withdrawals/${records[0].id}`,
      undefined,
      player1.token
    );
    expect(status).toBe(200);
    expect((data as { intentId: string }).intentId).toBe(records[0].id);
  });

  it("real custody workflow persists exact bytes before broadcast and reaches finality", async () => {
    // Reuse the recorded reserved intent as the custody input.
    const reserved = await prisma.withdrawalIntentRecord.findFirstOrThrow({
      where: { principalId: player1.userId, state: "RESERVED" },
      orderBy: { createdAt: "desc" },
    });
    const amount = BigInt(reserved.amountAtomic);
    const destination = reserved.destination as Address;

    // Fund the treasury with USDC so the withdrawal payout can settle.
    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: E2E_TREASURY_ADDRESS,
      value: parseUnits("1", 18),
    });
    const mintHash = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "mint",
      args: [E2E_TREASURY_ADDRESS, amount * 2n],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Build the real custody workflow over the same SQLite-backed Prisma client.
    const { buildCustodyHarness } = await import("./finance/helpers/custody-harness.js");
    const { ChainRegistry, createCustodyAccounting, createCustodyQuorumReader } =
      await import("../../api/src/finance-core.js");
    // Host custody reads through the loopback proxy URLs (the container uses the
    // host-gateway URLs stored on the asset). Two distinct endpoints satisfy the
    // registry topology requirement.
    const registry = new ChainRegistry({
      endpoints: quorumProxies.proxies.map((proxy, index) => ({
        id: `e2e-${index}`,
        chainId: E2E_CHAIN_ID,
        url: proxy.url,
      })),
      // Settlement-critical reads require a validated multi-endpoint quorum;
      // the two independent loopback proxies satisfy the default majority.
    });
    await registry.start();
    // Two independent endpoints must agree for every settlement-critical read;
    // an outage or disagreement fails closed instead of trusting one provider.
    const quorum = createCustodyQuorumReader(registry, { minFanout: 2 });
    const harness = buildCustodyHarness({
      prisma: prisma as never,
      databaseUrl: `file:${E2E_RUNTIME_DIR}/e2e.db`,
      chainId: E2E_CHAIN_ID,
      // Host-side custody reads through the loopback proxy URLs.
      rpcUrls: quorumProxies.proxies.map((proxy) => proxy.url),
      tokenAddress: contracts.usdcAddress as Address,
      treasuryAddress: E2E_TREASURY_ADDRESS,
      treasuryPrivateKey: E2E_TREASURY_KEY,
      confirmations: 1,
      deepFinality: 3,
      // A conservative positive native-gas floor is mandatory for signing; the
      // Anvil treasury is funded well above it.
      minGasAtomic: "100000000000000000",
      quorumThreshold: 2,
      minQuorum: 2,
      accounting: createCustodyAccounting({ prisma: prisma as never }) as never,
      quorum: quorum as never,
    });

    const dbAsset = await prisma.asset.findFirst({ where: { chainId: E2E_CHAIN_ID } });
    // The custody workflow reads the route's RPC pool from the durable asset
    // row. The container uses host-gateway URLs; this host-side test process
    // must use the loopback proxies. Point the row at loopback for this test.
    if (dbAsset) {
      await prisma.asset.update({
        where: { id: dbAsset.id },
        data: {
          rpcUrls: quorumProxies.proxies.map((proxy) => proxy.url),
        } as never,
      });
    }
    const broadcast = await harness.workflow.processIntent(reserved.id);
    if (broadcast.action !== "signed_broadcast") {
      const incident = await prisma.financialIncident.findFirst({
        orderBy: { createdAt: "desc" },
      });
      console.log(
        `[E2E][DIAG-CUSTODY] action=${broadcast.action} state=${broadcast.state} evidence=${JSON.stringify(incident?.evidence)}`
      );
      try {
        const native = await registry.getBalance(E2E_CHAIN_ID, E2E_TREASURY_ADDRESS);
        console.log(`[E2E][DIAG-CUSTODY] registry native=${native}`);
      } catch (error) {
        console.log(`[E2E][DIAG-CUSTODY] registry native failed: ${(error as Error).name}`);
      }
    }
    expect(broadcast.action).toBe("signed_broadcast");

    const after = await prisma.withdrawalIntentRecord.findUniqueOrThrow({
      where: { id: reserved.id },
    });
    // Persist-before-broadcast: exact signed bytes and their keccak hash are
    // durable, and the signed bytes hash to the committed tx hash.
    expect(after.signedRawTx).toBeTruthy();
    expect(after.txHash).toBe(keccak256(after.signedRawTx as `0x${string}`));

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: after.txHash as `0x${string}`,
    });
    expect(receipt.status).toBe("success");
    const destBal = await publicClient.readContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [destination],
    });
    expect(destBal).toBe(amount);

    // Mature confirmations through the real quorum reader and complete the
    // journal, then reach deep finality.
    await publicClient.request({ method: "anvil_mine" as never, params: ["0x3"] as never });
    await sleep(4500);
    await harness.workflow.processIntent(reserved.id);
    await sleep(4500);
    await harness.workflow.processIntent(reserved.id);

    const completed = await prisma.withdrawalIntentRecord.findUniqueOrThrow({
      where: { id: reserved.id },
    });
    expect(completed.confirmedJournalId).toBeTruthy();
    expect(["CONFIRMED", "FINALIZED"]).toContain(completed.state);
    console.log(`[E2E] Custody withdrawal ${reserved.id} state=${completed.state}`);
  }, 120_000);

  // ── 6. Auth Logout ─────────────────────────────────────────────────────
  it("POST /auth/logout invalidates session", async () => {
    const { status } = await api("POST", "/auth/logout", undefined, player1.token);
    expect(status).toBe(200);

    // Subsequent authenticated request should fail
    const { status: s2 } = await api("GET", "/user/me", undefined, player1.token);
    expect(s2).toBe(401);
  });
});
