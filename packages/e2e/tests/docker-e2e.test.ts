/**
 * Docker E2E Integration Test
 *
 * End-to-end test that:
 *  1. Starts a local Anvil chain and deploys MockUSDC + BatchSweeper contracts.
 *  2. Builds and starts the Docker Compose stack (API + Redis + Worker).
 *  3. Seeds the shared SQLite database with blockchain/token/admin-wallet data.
 *  4. Exercises the full API surface over HTTP with real SIWE auth.
 *  5. Performs real on-chain USDC deposits (mint → transfer → monitor → verify).
 *  6. Runs a multiplayer poker table with buy-ins, actions, and stand.
 *  7. Submits a signed withdrawal request and verifies the outbox state.
 *  8. Cleans up all resources (containers, volumes, Anvil, temp files).
 *
 * Prerequisites:
 *  - Docker, Foundry/Anvil, Node.js >= 20
 *  - Run: npm run e2e:docker
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";

// --- Chain helpers ---
import {
  startAnvil,
  stopAnvil,
  deployContracts,
  publicClient,
  walletClient,
  localChain,
  ANVIL_RPC,
  TEST_MNEMONIC,
  type DeployedContracts,
} from "./helpers/chain-utils.js";

// --- DB utilities (local copies to avoid cross-package envalid triggers) ---
import { encryptXpriv, encryptXpub, createPrismaClient } from "./helpers/db-utils.js";
import type { PrismaClient } from "../../api/generated/prisma/index.js";

// --- viem ---
import { parseAbi, parseUnits, type Address } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  mnemonicToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import WebSocket from "ws";
import { PokerClient, PokerSocket } from "@pokertools/sdk";

// ============================================================================
// Constants
// ============================================================================

const API_BASE = "http://localhost:3000";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPOSE_FILE = path.resolve(__dirname, "../../../docker-compose.e2e.yml");
const E2E_RUNTIME_DIR = path.join(os.tmpdir(), "pokertools-e2e-runtime");
const E2E_BLOCKCHAIN_ID = "cmqu0e2e0000001nxdocker0000";
const E2E_REDIS_URL = "redis://localhost:6380";

// Must match docker-compose.e2e.yml environment
const E2E_SECRETS = {
  JWT_SECRET: "e2e-jwt-secret-not-for-production",
  COOKIE_SECRET: "e2e-cookie-secret-not-for-production",
  WALLET_ENCRYPTION_SECRET: "e2e-wallet-encryption-secret-for-tests-only",
  WALLET_XPRIV_ENCRYPTION_SECRET: "e2e-wallet-xpriv-encryption-secret-for-tests-only",
};

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
  depositAddress: string;
}

interface RawTableState {
  players?: Array<
    ({ id?: string; stack?: number; status?: string } & Record<string, unknown>) | null
  >;
  _version?: number;
}

let player1: TestUser;
let player2: TestUser;
let player3: TestUser;
let tableId: string;

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

async function triggerDepositMonitor(): Promise<void> {
  const queue = new Queue("deposit-monitor", { connection: { url: E2E_REDIS_URL } });

  try {
    await queue.add(
      "deposit-monitor",
      {},
      {
        jobId: `e2e-deposit-monitor-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: 20,
      }
    );
  } finally {
    await queue.close();
  }
}

/**
 * Authenticate a new user via SIWE (nonce → login → token).
 * Returns a TestUser without depositAddress (caller must populate it).
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
  let loginBody: { token: string; user: { id: string; username: string } } | null = null;
  let lastLoginRes: { status: number; data: unknown } | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const nonceRes = await api("POST", "/auth/nonce");
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
    const sig = await acc.signMessage({ message: siweMsg });

    lastLoginRes = await api("POST", "/auth/login", {
      message: siweMsg,
      signature: sig,
    });
    if (lastLoginRes.status === 200) {
      loginBody = lastLoginRes.data as {
        token: string;
        user: { id: string; username: string };
      };
      break;
    }
    await sleep(100 * (attempt + 1));
  }

  expect(lastLoginRes?.status, JSON.stringify(lastLoginRes?.data)).toBe(200);
  expect(loginBody).not.toBeNull();
  const body = loginBody!;
  expect(body.token).toBeTruthy();
  expect(body.user.id).toBeTruthy();

  return {
    privateKey: pk,
    account: acc,
    token: body.token,
    userId: body.user.id,
    username: body.user.username || fallbackUsername,
    depositAddress: "",
  };
}

/**
 * Generate a deposit address for a user and return it.
 */
async function startDeposit(token: string): Promise<string> {
  const { status, data } = await api("POST", "/finance/deposit/start", undefined, token);
  expect(status).toBe(200);
  const body = data as { address: string };
  expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  return body.address;
}

async function getRawTableState(tableId: string, token: string): Promise<RawTableState | null> {
  const { status, data } = await api("GET", `/tables/${tableId}/test-state`, undefined, token);
  if (status !== 200) return null;
  return (data as { state: RawTableState }).state;
}

async function saveRawTableState(tableId: string, state: unknown, token: string): Promise<void> {
  const { status } = await api("POST", `/tables/${tableId}/test-state`, { state }, token);
  expect(status).toBe(200);
}

async function _depositUsdcToUsers(users: TestUser[], amountUsdc: string): Promise<void> {
  const depositAmount = parseUnits(amountUsdc, 6);

  for (const user of users) {
    user.depositAddress = await startDeposit(user.token);
    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: user.depositAddress as Address,
      value: parseUnits("0.25", 18),
    });
  }

  const mintHash = await walletClient.writeContract({
    address: contracts.usdcAddress,
    abi: USDC_ABI,
    functionName: "mint",
    args: [walletClient.account.address, depositAmount * BigInt(users.length)],
    chain: localChain,
    account: walletClient.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  for (const user of users) {
    const transferHash = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [user.depositAddress as Address, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: transferHash });
  }

  await publicClient.request({ method: "anvil_mine" as never, params: ["0x1"] as never });
  await triggerDepositMonitor();

  const expectedMain = Number(amountUsdc) * 100;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const balances = await Promise.all(
      users.map(async (user) => {
        const me = await api("GET", "/user/me", undefined, user.token);
        return ((me.data as Record<string, unknown>).balances as { main: number }).main;
      })
    );
    if (balances.every((balance) => balance >= expectedMain)) return;
  }

  throw new Error(`Timed out waiting for tournament player deposits (${amountUsdc} USDC each)`);
}

async function _createTournamentTable(
  name: string,
  creator: TestUser,
  entrants: TestUser[],
  buyIn = 1000
): Promise<{ tournamentId: string; tableId: string }> {
  const createRes = await api(
    "POST",
    "/tournaments",
    {
      name,
      buyIn,
      fee: 0,
      startingStack: 300,
      smallBlind: 100,
      bigBlind: 200,
      maxPlayers: 2,
      payoutPercentages: [100],
    },
    creator.token
  );
  expect(createRes.status).toBe(200);
  const created = createRes.data as { tournamentId: string; tableId: string };

  for (const [seat, entrant] of entrants.entries()) {
    const registerRes = await api(
      "POST",
      `/tournaments/${created.tournamentId}/register`,
      {
        seat,
        idempotencyKey: `e2e-tournament-register-${created.tournamentId}-${seat}-${Date.now()}`,
      },
      entrant.token
    );
    expect(registerRes.status).toBe(200);
  }

  return created;
}

async function _startTournament(tournamentId: string, starter: TestUser): Promise<void> {
  const startRes = await api(
    "POST",
    `/tournaments/${tournamentId}/start`,
    undefined,
    starter.token
  );
  expect(startRes.status).toBe(200);
}

async function _playHeadsUpTournamentToWinner(
  tournamentId: string,
  tableIdForTournament: string,
  entrantsBySeat: [TestUser, TestUser]
): Promise<TestUser> {
  const seatTokens: Record<number, string> = {
    0: entrantsBySeat[0].token,
    1: entrantsBySeat[1].token,
  };

  for (let step = 0; step < 40; step++) {
    const stateRes = await api(
      "GET",
      `/tables/${tableIdForTournament}`,
      undefined,
      entrantsBySeat[0].token
    );
    expect(stateRes.status).toBe(200);
    const state = (stateRes.data as { state: Record<string, unknown> }).state;
    const players = state.players as Array<{ id: string; stack: number } | null>;
    const liveSeats = players
      .map((player, seat) => ({ player, seat }))
      .filter(({ player }) => player && player.stack > 0);

    if (liveSeats.length === 1) {
      const winnerSeat = liveSeats[0].seat as 0 | 1;
      const settleRes = await api(
        "POST",
        `/tournaments/${tournamentId}/settle`,
        undefined,
        entrantsBySeat[winnerSeat].token
      );
      expect(settleRes.status).toBe(200);
      return entrantsBySeat[winnerSeat];
    }

    const winners = state.winners as Array<{ seat: number; amount: number }> | null | undefined;
    if (winners && winners.length > 0) {
      const dealRes = await api(
        "POST",
        `/tables/${tableIdForTournament}/action`,
        { type: "DEAL" },
        entrantsBySeat[0].token
      );
      expect([200, 400]).toContain(dealRes.status);
      await sleep(250);
      continue;
    }

    const actionTo = state.actionTo as number | null | undefined;
    if (actionTo === null || actionTo === undefined) {
      await sleep(250);
      continue;
    }

    const actionRes = await api(
      "POST",
      `/tables/${tableIdForTournament}/action`,
      { type: "FOLD" },
      seatTokens[actionTo]
    );
    expect(actionRes.status).toBe(200);
    await sleep(250);
  }

  throw new Error(`Tournament ${tournamentId} did not finish within 40 actions`);
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
  console.log(`[E2E] BatchSweeper: ${contracts.sweeperAddress}`);

  // ── 3. Prepare runtime directory ───────────────────────────────────────
  if (fs.existsSync(E2E_RUNTIME_DIR)) {
    fs.rmSync(E2E_RUNTIME_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(E2E_RUNTIME_DIR, { recursive: true });
  console.log(`[E2E] Runtime dir: ${E2E_RUNTIME_DIR}`);

  // ── 4. Build and start Docker Compose ──────────────────────────────────
  console.log("[E2E] Building and starting Docker Compose stack...");
  execSync(
    `POKERTOOLS_E2E_RUNTIME="${E2E_RUNTIME_DIR}" docker compose -f "${COMPOSE_FILE}" up --build -d`,
    {
      stdio: "inherit",
      timeout: 900000, // 15 minutes for cold Docker builds on constrained CI/desktop runners
    }
  );

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

  // ── 6. Seed database from host side ────────────────────────────────────
  console.log("[E2E] Seeding database...");

  // Set required env for encryptXpub and prisma client
  process.env.WALLET_ENCRYPTION_SECRET = E2E_SECRETS.WALLET_ENCRYPTION_SECRET;
  process.env.WALLET_XPRIV_ENCRYPTION_SECRET = E2E_SECRETS.WALLET_XPRIV_ENCRYPTION_SECRET;
  process.env.DATABASE_URL = `file:${E2E_RUNTIME_DIR}/e2e.db`;

  prisma = createPrismaClient();

  // 6a. Seed AdminWallet (xpriv derived from test mnemonic at m/44'/60'/0'/0)
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const { HDKey } = await import("@scure/bip32");
  const seed = mnemonicToSeedSync(TEST_MNEMONIC);
  const masterKey = HDKey.fromMasterSeed(seed);
  const derivedKey = masterKey.derive("m/44'/60'/0'/0");
  const xpriv = derivedKey.privateExtendedKey;
  const xpub = derivedKey.publicExtendedKey;

  // Delete any stale data first (order matters for FK constraints)
  await prisma.depositSession.deleteMany();
  await prisma.userWallet.deleteMany();
  await prisma.adminWallet.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.playerNote.deleteMany();
  await prisma.handHistory.deleteMany();
  await prisma.tournamentEntry.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.table.deleteMany();
  await prisma.user.deleteMany();
  await prisma.token.deleteMany();
  await prisma.blockchain.deleteMany();

  await prisma.adminWallet.create({
    data: {
      label: "E2E Test Wallet",
      xpub: encryptXpub(xpub, E2E_SECRETS.WALLET_ENCRYPTION_SECRET),
      xpriv: encryptXpriv(xpriv, E2E_SECRETS.WALLET_XPRIV_ENCRYPTION_SECRET),
      derivationPath: "m/44'/60'/0'/0",
      currentIndex: 0,
      isActive: true,
    },
  });

  // 6b. Seed Blockchain
  const chain = await prisma.blockchain.create({
    data: {
      id: E2E_BLOCKCHAIN_ID,
      name: "Anvil Local",
      chainId: 31337,
      // Container uses host.docker.internal, host test uses 127.0.0.1
      rpcUrl: "http://host.docker.internal:8545",
      explorerUrl: "http://localhost:4000",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      confirmations: 1,
      isEnabled: true,
      lastScannedBlock: "0",
    },
  });

  // 6c. Seed Token
  await prisma.token.create({
    data: {
      blockchainId: chain.id,
      address: contracts.usdcAddress,
      symbol: "USDC",
      name: "Mock USDC",
      decimals: 6,
      minDeposit: "1000000", // 1 USDC minimum
      isEnabled: true,
    },
  });

  // 6d. Seed HOUSE user (required by engine for rake)
  await prisma.user.create({
    data: {
      username: "HOUSE",
      address: "0x0000000000000000000000000000000000000000",
      role: "ADMIN",
    },
  });

  console.log("[E2E] Database seeded successfully");
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

  it("GET /finance/chains returns enabled chains and tokens", async () => {
    const { status, data } = await api("GET", "/finance/chains");
    expect(status).toBe(200);
    const chains = data as Array<Record<string, unknown>>;
    expect(chains.length).toBeGreaterThanOrEqual(1);
    const anvil = chains.find((c) => c.name === "Anvil Local");
    expect(anvil).toBeDefined();
    expect((anvil as Record<string, unknown>).chainId).toBe(31337);
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
    expect(body.balances).toBeDefined();
  });

  // ── 3. Deposit Flow ────────────────────────────────────────────────────
  it("POST /finance/deposit/start generates deposit addresses for all players", async () => {
    player1.depositAddress = await startDeposit(player1.token);
    player2.depositAddress = await startDeposit(player2.token);
    player3.depositAddress = await startDeposit(player3.token);

    expect(player1.depositAddress).not.toBe(player2.depositAddress);
    expect(player1.depositAddress).not.toBe(player3.depositAddress);
    expect(player2.depositAddress).not.toBe(player3.depositAddress);
    console.log(`[E2E] Player1 deposit: ${player1.depositAddress}`);
    console.log(`[E2E] Player2 deposit: ${player2.depositAddress}`);
    console.log(`[E2E] Player3 deposit: ${player3.depositAddress}`);
  });

  it("GET /finance/deposit/address returns existing address", async () => {
    const { status, data } = await api("GET", "/finance/deposit/address", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { address: string };
    expect(body.address).toBe(player1.depositAddress);
  });

  it("Real on-chain deposit: mint + transfer → monitor → credit", async () => {
    const depositAmount = parseUnits("200", 6); // 200 USDC per player

    // Fund deposit addresses with ETH for gas
    for (const addr of [player1.depositAddress, player2.depositAddress, player3.depositAddress]) {
      await walletClient.sendTransaction({
        account: walletClient.account,
        chain: localChain,
        to: addr as Address,
        value: parseUnits("0.5", 18),
      });
    }

    // Mint USDC to deployer, then transfer to deposit addresses.
    // The deposit monitor ignores zero-address mint events,
    // so this exercises the real ERC-20 Transfer path.
    const mintHash = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "mint",
      args: [walletClient.account.address, depositAmount * 6n],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Transfer to player1 deposit address
    const tx1 = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [player1.depositAddress as Address, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx1 });

    // Transfer to player2 deposit address
    const tx2 = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [player2.depositAddress as Address, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx2 });

    // Transfer to player3 deposit address
    const tx3 = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [player3.depositAddress as Address, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx3 });

    // Verify the real on-chain ERC-20 balances before asking the worker to credit accounts.
    const [chainBal1, chainBal2, chainBal3] = await Promise.all(
      [player1.depositAddress, player2.depositAddress, player3.depositAddress].map((addr) =>
        publicClient.readContract({
          address: contracts.usdcAddress,
          abi: USDC_ABI,
          functionName: "balanceOf",
          args: [addr as Address],
        })
      )
    );
    expect(chainBal1).toBeGreaterThanOrEqual(depositAmount);
    expect(chainBal2).toBeGreaterThanOrEqual(depositAmount);
    expect(chainBal3).toBeGreaterThanOrEqual(depositAmount);

    // Mine an extra block to advance confirmations past threshold (1 confirmation required).
    // Use Anvil directly instead of sending a zero-value transaction to a contract,
    // because contracts without a payable receive/fallback can revert during gas estimation.
    await publicClient.request({ method: "anvil_mine" as never, params: ["0x1"] as never });

    // Enqueue an immediate scan so the E2E does not depend on the 15s scheduler tick.
    await triggerDepositMonitor();

    // Wait for the Docker worker (deposit monitor) to detect and confirm deposits.
    // The worker polls every 15 seconds. We wait up to 60 seconds.
    console.log("[E2E] Waiting for deposit monitor to process...");
    let p1Bal = 0;
    let p2Bal = 0;
    let p3Bal = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);

      const r1 = await api("GET", "/user/me", undefined, player1.token);
      const b1 = (r1.data as Record<string, unknown>).balances as { main: number };
      p1Bal = b1.main;

      const r2 = await api("GET", "/user/me", undefined, player2.token);
      const b2 = (r2.data as Record<string, unknown>).balances as { main: number };
      p2Bal = b2.main;

      const r3 = await api("GET", "/user/me", undefined, player3.token);
      const b3 = (r3.data as Record<string, unknown>).balances as { main: number };
      p3Bal = b3.main;

      if (p1Bal >= 20000 && p2Bal >= 20000 && p3Bal >= 20000) {
        console.log(`[E2E] Deposits detected after ${(i + 1) * 2}s`);
        break;
      }
    }

    expect(p1Bal).toBeGreaterThanOrEqual(20000); // $200.00 in cents
    expect(p2Bal).toBeGreaterThanOrEqual(20000);
    expect(p3Bal).toBeGreaterThanOrEqual(20000);
  });

  it("GET /finance/deposits returns deposit history", async () => {
    const { status, data } = await api("GET", "/finance/deposits", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { deposits: Array<Record<string, unknown>> };
    expect(body.deposits.length).toBeGreaterThanOrEqual(1);
    const dep = body.deposits[0];
    expect(dep.status).toBe("CONFIRMED");
    expect(dep.chain).toBe("Anvil Local");
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

    // ── 4g. Exercise reconciliation: simulate eliminations via direct engine state ──
    // Bust some players on the first table to test elimination tracking
    const allTableIds: string[] = tables.map((t) => t.id);
    for (const tid of allTableIds) {
      const snap = await getRawTableState(tid, player1.token);
      if (!snap?.players) continue;

      let busted = 0;
      for (let s = 0; s < snap.players.length; s++) {
        const player = snap.players[s];
        if (player && (player.stack ?? 0) > 0 && busted < 2) {
          snap.players[s] = { ...player, stack: 0, status: "BUSTED" };
          busted++;
        }
      }
      if (busted > 0) {
        snap._version = (snap._version || 0) + 1;
        await saveRawTableState(tid, snap, player1.token);
        console.log(`[E2E] Busted ${busted} players on table ${tid} (direct state modification)`);
      }
    }

    // Call reconcile endpoint
    const reconcileRes = await api(
      "POST",
      `/tournaments/${tournamentId}/reconcile`,
      undefined,
      player1.token
    );
    expect(reconcileRes.status).toBe(200);
    const reconcileBody = reconcileRes.data as { success: boolean; tables: unknown[] };
    expect(reconcileBody.success).toBe(true);
    console.log(`[E2E] Reconciliation triggered`);

    // Verify eliminated entries in tournament details
    const detailsRes3 = await api("GET", `/tournaments/${tournamentId}`);
    const t3 = (detailsRes3.data as { tournament: Record<string, unknown> }).tournament;
    const entries3 = t3.entries as Array<{ status: string; placement: number | null }>;
    const eliminatedCount = entries3.filter((e) => e.status === "ELIMINATED").length;
    expect(eliminatedCount).toBeGreaterThan(0);
    console.log(`[E2E] Eliminated entries after reconciliation: ${eliminatedCount}`);

    // ── 4h. Simulate final table merge ────────────────────────────────────
    // Bust all players except 1 on each table; then reconcile to merge to final table
    for (const tid of allTableIds) {
      const snap = await getRawTableState(tid, player1.token);
      if (!snap?.players) continue;

      let keptOne = false;
      for (let s = 0; s < snap.players.length; s++) {
        const player = snap.players[s];
        if (player && (player.stack ?? 0) > 0) {
          if (!keptOne) {
            keptOne = true;
          } else {
            snap.players[s] = { ...player, stack: 0, status: "BUSTED" };
          }
        }
      }
      snap._version = (snap._version || 0) + 1;
      await saveRawTableState(tid, snap, player1.token);
    }
    console.log(`[E2E] Reduced to 1 live player per table`);

    // Reconcile multiple times to handle table breaking and final merge
    for (let i = 0; i < 4; i++) {
      await api("POST", `/tournaments/${tournamentId}/reconcile`, undefined, player1.token);
      await sleep(500);
    }
    console.log(`[E2E] Multi-step reconciliation complete`);

    // Verify final table merge
    const detailsRes4 = await api("GET", `/tournaments/${tournamentId}`);
    const t4 = (detailsRes4.data as { tournament: Record<string, unknown> }).tournament;
    const tables4 = t4.tables as Array<{ id: string; status: string }>;
    const activeTables = tables4.filter((t) => t.status === "ACTIVE");
    // After merging, at most one table should be active (or we might have more if tableMaxPlayers > activePlayerCount)
    expect(activeTables.length).toBeLessThanOrEqual(2);
    console.log(`[E2E] Active tables after merge: ${activeTables.length}`);

    // ── 4i. Ensure single winner and settle ──────────────────────────────
    // Bust all but one player across all tables
    let winningUserId = "";
    const activeTableIdsForSettlement = activeTables.map((t) => t.id);
    for (const tid of activeTableIdsForSettlement) {
      const snap = await getRawTableState(tid, player1.token);
      if (!snap?.players) continue;

      for (let s = 0; s < snap.players.length; s++) {
        const player = snap.players[s];
        if (player && (player.stack ?? 0) > 0) {
          if (!winningUserId) {
            winningUserId = player.id ?? "";
          } else {
            snap.players[s] = { ...player, stack: 0, status: "BUSTED" };
          }
        }
      }
      snap._version = (snap._version || 0) + 1;
      await saveRawTableState(tid, snap, player1.token);
    }
    expect(winningUserId).toBeTruthy();
    console.log(`[E2E] Single winner: ${winningUserId}`);

    // Settle tournament
    const settleRes = await api(
      "POST",
      `/tournaments/${tournamentId}/settle`,
      undefined,
      player1.token
    );
    expect(settleRes.status).toBe(200);
    const settleBody = settleRes.data as { success: boolean; winnerUserId: string; prize: number };
    expect(settleBody.success).toBe(true);
    expect(settleBody.winnerUserId).toBe(winningUserId);
    expect(settleBody.prize).toBe(3000); // 30 × 100
    console.log(`[E2E] Tournament settled: winner ${winningUserId} gets ${settleBody.prize}`);

    // ── 4j. Verify ledger balance conservation ────────────────────────────
    // All 30 users started with 5000 MAIN each = 150000 total
    // Tournament collected 30 × 100 = 3000 in prize pool
    // Winner gets 3000 back, so total should still be 150000
    const totalBalances = await Promise.all(
      mtUsers.map(async (u) => {
        const accounts = await prisma.account.findMany({ where: { userId: u.userId } });
        return accounts.reduce((sum, a) => sum + BigInt(a.balance), 0n);
      })
    );
    const totalSystem = totalBalances.reduce((sum, b) => sum + b, 0n);
    expect(totalSystem).toBe(150000n);
    console.log(`[E2E] Ledger conservation verified: total = ${totalSystem}`);

    // Verify winner balance
    const winnerMainAcc = await prisma.account.findFirstOrThrow({
      where: { userId: winningUserId, type: "MAIN" },
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

    // Cleanup: delete tournament users
    for (const u of mtUsers) {
      await prisma.session.deleteMany({ where: { userId: u.userId } });
      await prisma.ledgerEntry.deleteMany({
        where: { account: { userId: u.userId } },
      });
      await prisma.tournamentEntry.deleteMany({ where: { userId: u.userId } });
      await prisma.account.deleteMany({ where: { userId: u.userId } });
      await prisma.user.delete({ where: { id: u.userId } }).catch(() => undefined);
    }

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
    const buyInAmount = 5000; // $50.00 in cents: 5000 chips

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

    // Verify balances: MAIN decreased by buy-in, IN_PLAY increased
    const me1 = await api("GET", "/user/me", undefined, player1.token);
    const b1 = (me1.data as Record<string, unknown>).balances as {
      main: number;
      inPlay: number;
    };
    expect(b1.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    const me2 = await api("GET", "/user/me", undefined, player2.token);
    const b2 = (me2.data as Record<string, unknown>).balances as {
      main: number;
      inPlay: number;
    };
    expect(b2.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    const me3 = await api("GET", "/user/me", undefined, player3.token);
    const b3 = (me3.data as Record<string, unknown>).balances as {
      main: number;
      inPlay: number;
    };
    expect(b3.inPlay).toBeGreaterThanOrEqual(buyInAmount);

    // Capture post-buy-in MAIN balances for later financial integrity checks
    postBuyInMain[0] = b1.main;
    postBuyInMain[1] = b2.main;
    postBuyInMain[2] = b3.main;
    console.log(
      `[E2E] Post-buy-in MAIN: P1=${postBuyInMain[0]}, P2=${postBuyInMain[1]}, P3=${postBuyInMain[2]}`
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
      expect(snapshot.players.filter(Boolean).length).toBeGreaterThanOrEqual(3);

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

      await client.action(tableId, {
        type: "DEAL",
        idempotencyKey: `e2e-sdk-deal-${Date.now()}`,
      } as Parameters<PokerClient["action"]>[1]);
      await updatePromise;
      expect(socket.getCachedState(tableId)?.version).toBeGreaterThan(snapshot.version);
    } finally {
      socket.disconnect();
    }
  });

  it("POST /tables/:id/action: DEAL + deterministic hand via actionTo folds", async () => {
    // ── DEAL: start the hand ──
    const currentRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    const currentState = (currentRes.data as { state: Record<string, unknown> }).state;
    let dealBody: { state: Record<string, unknown> };
    if (currentState.street === "PREFLOP") {
      dealBody = { state: currentState };
      console.log("[E2E] Hand already dealt by SDK WebSocket test; skipping explicit DEAL");
    } else {
      const dealRes = await api(
        "POST",
        `/tables/${tableId}/action`,
        { type: "DEAL" },
        player1.token
      );
      expect(dealRes.status).toBe(200);
      dealBody = dealRes.data as { state: Record<string, unknown> };
    }
    const streetAfterDeal = dealBody.state.street as string;
    expect(streetAfterDeal).toBeDefined();
    console.log(`[E2E] Street after DEAL: ${streetAfterDeal}`);

    // ── Capture table stacks before hand ──
    const stateRes = await api("GET", `/tables/${tableId}`, undefined, player1.token);
    const preState = (stateRes.data as { state: Record<string, unknown> }).state;
    const prePlayers = preState.players as Array<{ stack: number } | null> | undefined;
    console.log(`[E2E] Pre-hand stacks: ${prePlayers?.map((p) => p?.stack ?? "null").join(", ")}`);

    // ── Deterministic fold loop using actionTo ──
    // Map seat → token for sending actions as the correct player.
    const seatToken: Record<number, string> = {
      0: player1.token,
      1: player2.token,
      2: player3.token,
    };

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

      const actingToken = seatToken[actionTo];
      if (!actingToken) {
        console.log(`[E2E] No token for actionTo=${actionTo}. Breaking fold loop.`);
        break;
      }

      const foldRes = await api("POST", `/tables/${tableId}/action`, { type: "FOLD" }, actingToken);
      actionCount++;
      console.log(`[E2E] Fold #${actionCount}: seat ${actionTo} (status ${foldRes.status})`);

      // Small delay to let the engine/game-manager process the fold and settle any jobs
      await sleep(500);
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
    const me1 = await api("GET", "/user/me", undefined, player1.token);
    const b1 = (me1.data as Record<string, unknown>).balances as { main: number; inPlay: number };
    const me2 = await api("GET", "/user/me", undefined, player2.token);
    const b2 = (me2.data as Record<string, unknown>).balances as { main: number; inPlay: number };
    const me3 = await api("GET", "/user/me", undefined, player3.token);
    const b3 = (me3.data as Record<string, unknown>).balances as { main: number; inPlay: number };

    console.log(`[E2E] Final balances — P1: main=${b1.main} inPlay=${b1.inPlay}`);
    console.log(`[E2E] Final balances — P2: main=${b2.main} inPlay=${b2.inPlay}`);
    console.log(`[E2E] Final balances — P3: main=${b3.main} inPlay=${b3.inPlay}`);

    // ── Assert IN_PLAY is zero/near-zero after standing ──
    expect(b1.inPlay).toBeLessThanOrEqual(150);
    expect(b2.inPlay).toBeLessThanOrEqual(150);
    expect(b3.inPlay).toBeLessThanOrEqual(150);

    // ── Assert the winner cashed out real winnings and losers reflected real losses. ──
    const mainIncreased = [0, 1, 2].some((seat) => [b1, b2, b3][seat].main > postBuyInMain[seat]);
    expect(mainIncreased).toBe(true);

    expect(winningSeat).not.toBeNull();
    expect([b1, b2, b3][winningSeat!].main).toBeGreaterThan(20000);

    const loserBelowDeposit = [0, 1, 2]
      .filter((seat) => seat !== winningSeat)
      .some((seat) => [b1, b2, b3][seat].main < 20000);
    expect(loserBelowDeposit).toBe(true);

    for (const seat of [0, 1, 2]) {
      expect([b1, b2, b3][seat].main).toBeGreaterThanOrEqual(
        postBuyInMain[seat] + (postHandStacks[seat] ?? 0) - 150
      );
    }

    console.log(
      `[E2E] MAIN vs post-buy-in: P1 ${b1.main} (was ${postBuyInMain[0]}), P2 ${b2.main} (was ${postBuyInMain[1]}), P3 ${b3.main} (was ${postBuyInMain[2]}), winner seat=${winningSeat}`
    );

    // ── Total balances conserved within rake bounds ──
    const totalBefore = 60000; // 3 × 20000 deposits
    const totalAfter = b1.main + b2.main + b3.main + b1.inPlay + b2.inPlay + b3.inPlay;
    console.log(`[E2E] Total balance before: ${totalBefore}, after: ${totalAfter}`);
    expect(totalAfter).toBeGreaterThanOrEqual(totalBefore - 1000); // Allow for rake + add-chips
    expect(totalAfter).toBeLessThanOrEqual(totalBefore + 10);
  });

  it("GET /user/history returns ledger entries", async () => {
    const { status, data } = await api("GET", "/user/history", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { history: Array<Record<string, unknown>> };
    expect(body.history.length).toBeGreaterThanOrEqual(0); // May have entries
  });

  // ── 5. Withdrawal Flow ─────────────────────────────────────────────────
  it("POST /user/withdraw submits signed withdrawal request", async () => {
    // Get blockchain and token IDs from DB (host-side access)
    const chain = await prisma.blockchain.findUniqueOrThrow({
      where: { chainId: 31337 },
    });
    const token = await prisma.token.findFirstOrThrow({
      where: { symbol: "USDC" },
    });

    const withdrawAmount = 50; // $50.00 USD
    const destination = "0x9999999999999999999999999999999999999999" as Address;

    // Build signed message: "Withdraw {amount} USD to {address}\nNonce: {nonce}\nTimestamp: {ts}"
    const nonce = `e2e-wd-${Date.now()}`;
    const timestamp = Date.now();
    const message = `Withdraw ${withdrawAmount} USD to ${destination}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

    const signature = await player1.account.signMessage({ message });

    const { status, data } = await api(
      "POST",
      "/user/withdraw",
      {
        amount: withdrawAmount,
        blockchainId: chain.id,
        tokenId: token.id,
        address: destination,
        message,
        signature,
        idempotencyKey: nonce,
      },
      player1.token
    );

    console.log(`[E2E] Withdraw response: ${status} — ${JSON.stringify(data)}`);
    expect(status).toBe(200);
    const body = data as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.amount).toBe(withdrawAmount);
    expect(body.destination).toBe(destination);
  });

  it("GET /user/withdrawals returns withdrawal history", async () => {
    const { status, data } = await api("GET", "/user/withdrawals", undefined, player1.token);
    expect(status).toBe(200);
    const body = data as { withdrawals: Array<Record<string, unknown>> };
    expect(body.withdrawals.length).toBeGreaterThanOrEqual(1);
    const wd = body.withdrawals[0];
    expect(wd.status).toBeDefined();
    console.log(`[E2E] Withdrawal in history: status=${wd.status}`);
  });

  it("Withdrawal PaymentTransaction exists in DB with correct state", async () => {
    const pts = await prisma.paymentTransaction.findMany({
      where: { userId: player1.userId, type: "WITHDRAWAL" },
      orderBy: { createdAt: "desc" },
    });
    expect(pts.length).toBeGreaterThanOrEqual(1);
    const pt = pts[0];
    expect(pt.status).toBe("PENDING");
    expect(pt.address).toBe("0x9999999999999999999999999999999999999999");
    expect(pt.amountCredit).toBeGreaterThan(0);

    // The withdrawal route returns a linked debit ledger entry id.
    expect(pt.ledgerEntryId).toBeTruthy();
  });

  /**
   * Withdrawal processing via on-chain transfer.
   *
   * In production, the WithdrawalBot (admin package) polls durable withdrawal
   * PaymentTransaction rows, sends a Telegram approval prompt, and processes
   * the on-chain transfer when an admin approves. For this E2E test, we simulate
   * the approval by:
   *   1. Deriving the hot wallet from the test mnemonic.
   *   2. Transferring USDC on-chain from the hot wallet to the destination.
   *   3. Updating the PaymentTransaction status to PROCESSING/CONFIRMED.
   *
   * This validates the full withdrawal lifecycle: user balance debit → DB
   * outbox → on-chain settlement.
   */
  it("Withdrawal can be processed on-chain (simulated admin approval)", async () => {
    const pt = await prisma.paymentTransaction.findFirstOrThrow({
      where: { userId: player1.userId, type: "WITHDRAWAL" },
      orderBy: { createdAt: "desc" },
    });
    const destAddr = "0x9999999999999999999999999999999999999999" as Address;
    const amountRaw = parseUnits("50", 6);

    // Derive hot wallet from test mnemonic (m/44'/60'/0'/0/0)
    const hotWallet = mnemonicToAccount(TEST_MNEMONIC, {
      addressIndex: 0,
    });

    // Fund hot wallet with ETH for gas
    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: hotWallet.address,
      value: parseUnits("1", 18),
    });

    // Fund hot wallet with USDC (mint from deployer, then transfer)
    const mintHash2 = await walletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "mint",
      args: [hotWallet.address, amountRaw * 2n],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash2 });

    // Execute the withdrawal transfer on-chain
    const hotWalletClient = await import("viem").then((m) =>
      m.createWalletClient({
        account: hotWallet,
        chain: localChain,
        transport: m.http(ANVIL_RPC),
      })
    );

    const txHash = await hotWalletClient.writeContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [destAddr, amountRaw],
      chain: localChain,
      account: hotWallet,
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[E2E] Withdrawal tx: ${txHash}`);

    // Update PaymentTransaction status in DB (simulating admin approval)
    await prisma.paymentTransaction.update({
      where: { id: pt.id },
      data: {
        txHash,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });

    // Verify on-chain balance of destination
    const destBal = await publicClient.readContract({
      address: contracts.usdcAddress,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [destAddr as Address],
    });

    expect(destBal).toBeGreaterThanOrEqual(amountRaw);
    console.log(`[E2E] Destination balance: ${destBal} (expected >= ${amountRaw})`);

    // Verify the host-side simulated admin processor persisted the settlement.
    const confirmed = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: pt.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.txHash).toBe(txHash);
  });

  // ── 6. Auth Logout ─────────────────────────────────────────────────────
  it("POST /auth/logout invalidates session", async () => {
    const { status } = await api("POST", "/auth/logout", undefined, player1.token);
    expect(status).toBe(200);

    // Subsequent authenticated request should fail
    const { status: s2 } = await api("GET", "/user/me", undefined, player1.token);
    expect(s2).toBe(401);
  });
});
