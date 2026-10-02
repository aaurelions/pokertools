/// <reference path="../../types/fastify.d.ts" />
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  CanonicalActionResultSchema,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type LegalAction,
  type LegalActionFamily,
  type SeatObservation,
  type CreateTableRequest,
} from "@pokertools/types";
import { buildApp } from "../../src/app.js";

/**
 * Test user data structure
 */
export interface TestUser {
  id: string;
  username: string;
  address: string;
  token: string;
  jti: string;
}

/**
 * Test context for API integration tests
 */
export interface TestContext {
  app: FastifyInstance;
  users: TestUser[];
  tableId?: string;
  cleanup: (() => Promise<void>)[];
}

/**
 * Create a test user with authentication
 */
export async function createTestUser(
  app: FastifyInstance,
  username: string,
  initialBalance = 10000
): Promise<TestUser> {
  const randomId = Date.now() + Math.random();
  const address = `0x${username.toLowerCase()}${randomId}`;

  const user = await app.prisma.user.create({
    data: {
      username: `${username}_${randomId}`,
      address,
    },
  });

  // Canonical chip funding. `grantChips` is the only supported PLAY_CHIPS
  // funding path; the legacy cents Account/LedgerEntry model is not seeded.
  if (initialBalance > 0) {
    await app.financialManager.grantChips(user.id, initialBalance, {
      reason: "test_fixture",
      operatorId: user.id,
      idempotencyKey: `test-grant:${user.id}`,
    });
  }

  const jti = `test_${username}_${randomId}`;
  const token = await app.jwt.sign(
    { userId: user.id, address: user.address, jti },
    { jti, expiresIn: "1h" }
  );

  await app.prisma.session.create({
    data: {
      userId: user.id,
      jti,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });

  return {
    id: user.id,
    username: user.username,
    address: user.address ?? address,
    token,
    jti,
  };
}

/**
 * Clean up test user and all related data
 */
export async function cleanupTestUser(app: FastifyInstance, userId: string): Promise<void> {
  const tournaments = await app.prisma.tournament.findMany({
    where: {
      OR: [{ creatorId: userId }, { entries: { some: { userId } } }],
    },
    select: {
      id: true,
      tableId: true,
      tables: { select: { id: true } },
    },
  });

  for (const tournament of tournaments) {
    const tableIds = Array.from(
      new Set([tournament.tableId, ...tournament.tables.map((table) => table.id)])
    );
    await app.prisma.handHistory.deleteMany({ where: { tableId: { in: tableIds } } });
    await app.prisma.tournament.delete({ where: { id: tournament.id } }).catch(() => undefined);
    await app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
    await Promise.all(tableIds.map((tableId) => app.redis.del(`table:${tableId}`)));
  }

  await app.prisma.session.deleteMany({ where: { userId } });
  // Canonical chip journal/accounts are keyed by principal with no FK to User.
  await app.prisma.chipLedgerEntry.deleteMany({
    where: { account: { principalId: userId } },
  });
  await app.prisma.chipGrant.deleteMany({ where: { principalId: userId } });
  await app.prisma.chipAccount.deleteMany({ where: { principalId: userId } });
  await app.prisma.user.delete({ where: { id: userId } }).catch(() => {});
}

/**
 * Clean up test table and all related data
 */
export async function cleanupTestTable(app: FastifyInstance, tableId: string): Promise<void> {
  await app.prisma.handHistory.deleteMany({ where: { tableId } });
  await app.prisma.table.delete({ where: { id: tableId } }).catch(() => {});
  // Clean up Redis state
  await app.redis.del(`table:${tableId}`);
}

/**
 * Initialize test context with app and cleanup handlers
 */
export async function initTestContext(userCount = 2, initialBalance = 10000): Promise<TestContext> {
  const app = await buildApp();
  await app.ready();

  const users: TestUser[] = [];
  const cleanup: (() => Promise<void>)[] = [];

  // Create test users
  for (let i = 0; i < userCount; i++) {
    const user = await createTestUser(app, `player${i + 1}`, initialBalance);
    users.push(user);
  }

  // Add cleanup handlers. runCleanup executes in reverse order, so close the app
  // last after DB/Redis-backed cleanup has completed.
  cleanup.push(async () => {
    await app.close();
  });

  cleanup.push(async () => {
    for (const user of users) {
      await cleanupTestUser(app, user.id);
    }
  });

  return { app, users, cleanup };
}

/**
 * Execute cleanup handlers in reverse order
 */
export async function runCleanup(cleanup: (() => Promise<void>)[]): Promise<void> {
  for (const handler of cleanup.reverse()) {
    await handler();
  }
}

/**
 * Create a table via API
 */
export async function createTable(
  app: FastifyInstance,
  token: string,
  config: Omit<CreateTableRequest, "maxPlayers"> & { maxPlayers?: number }
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/tables",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      ...config,
      maxPlayers: config.maxPlayers ?? 6,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to create table: ${response.body}`);
  }

  const body = JSON.parse(response.body);
  return body.tableId;
}

/**
 * True when a 500 is the known post-commit Redlock release fault: the mutation
 * already committed and only the lock release failed. Retrying with the same
 * idempotency identity replays the stored result instead of re-executing.
 */
function isPostCommitLockFailure(body: string): boolean {
  return body.includes("Unable to fully release the lock");
}

/**
 * Buy in to a table (retries on rate limiting and post-commit lock-release).
 */
export async function buyIn(
  app: FastifyInstance,
  token: string,
  tableId: string,
  amount: number,
  seat: number,
  maxRetries = 3
): Promise<void> {
  const idempotencyKey = crypto.randomUUID();
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        amount: amount.toString(),
        seat,
        idempotencyKey,
      },
    });

    if (response.statusCode === 200) return;

    if (response.statusCode === 429) {
      // Rate limited — wait with exponential backoff then retry
      const body = JSON.parse(response.body);
      const isRisk = body.code === "RISK_DENIED";
      const delay = isRisk ? 2000 + attempt * 1000 : 1000 + attempt * 500;
      lastError = new Error(
        `Rate limited (${isRisk ? "risk" : "rate"}): ${response.body} — retrying in ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (response.statusCode === 500 && isPostCommitLockFailure(response.body)) {
      // The buy-in committed; only the lock release failed. Replay idempotently.
      const delay = 25 * (attempt + 1);
      lastError = new Error(`Post-commit lock failure: ${response.body} — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Failed to buy in: ${response.body}`);
  }
  throw lastError || new Error("Buy-in failed after retries");
}

/**
 * A requested gameplay action.
 *
 * This is the local, test-facing shape. The helper resolves the authoritative
 * legal action (family, opaque actionId and amount bounds) from the server
 * observation before submitting a canonical request. Actor hints passed by
 * legacy callers are ignored: the server derives the actor from authentication.
 */
export interface RequestedAction {
  /** Uppercase engine action family, e.g. `"CALL"` or `"RAISE"`. */
  type: string;
  /** Requested chip amount for BET/RAISE (an all-in shove included). */
  amount?: number;
  [key: string]: unknown;
}

/**
 * Fetch the authoritative per-seat observation for the authenticated principal.
 *
 * The returned `legalActions` are the only actions the principal may submit;
 * legality is never computed client-side.
 */
export async function getObservation(
  app: FastifyInstance,
  token: string,
  tableId: string
): Promise<SeatObservation> {
  const response = await app.inject({
    method: "GET",
    url: `/tables/${tableId}/observation`,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get observation: ${response.body}`);
  }

  return JSON.parse(response.body) as SeatObservation;
}

/**
 * Resolve the exact chip amount for a legal action without inventing legality.
 *
 * Mirrors the SDK: unbounded families take no amount; bounded families use the
 * requested amount, falling back to the server-precomputed amount. Bounds are
 * checked so the test fails locally with a clear message instead of relying on
 * a server 400.
 */
function resolveLegalAmount(legal: LegalAction, requested?: number): number | undefined {
  const bounded = legal.minAmount !== undefined || legal.maxAmount !== undefined;
  if (!bounded) {
    if (requested !== undefined) {
      throw new Error(`The ${legal.family} action takes no chip amount`);
    }
    return legal.amount;
  }

  const amount = requested ?? legal.amount ?? legal.minAmount;
  if (amount === undefined) {
    throw new Error(`A chip amount is required for the ${legal.family} action`);
  }
  if (legal.minAmount !== undefined && amount < legal.minAmount) {
    throw new Error(`Amount ${amount} is below minimum ${legal.minAmount} for ${legal.family}`);
  }
  if (legal.maxAmount !== undefined && amount > legal.maxAmount) {
    throw new Error(`Amount ${amount} is above maximum ${legal.maxAmount} for ${legal.family}`);
  }
  return amount;
}

/**
 * Resolve a requested action family against the authoritative legal actions and
 * build the strict canonical request.
 *
 * Throws when the server does not currently offer the requested family; that is
 * a real protocol violation, not something to paper over.
 */
export function toCanonicalActionRequest(
  observation: SeatObservation,
  requested: RequestedAction
): CanonicalActionRequest {
  const family = String(requested.type).toUpperCase() as LegalActionFamily;
  const legal = observation.legalActions.find((action) => action.family === family);
  if (!legal) {
    throw new Error(
      `Server did not offer a legal ${family} action (offered: ${observation.legalActions
        .map((action) => action.family)
        .join(", ")})`
    );
  }

  const amount = resolveLegalAmount(legal, requested.amount);
  return {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: legal.actionId,
    ...(amount === undefined ? {} : { amount }),
  };
}

/**
 * Execute a gameplay action through the canonical observation/action protocol.
 *
 * Fetches a fresh observation for the authenticated principal, resolves the
 * requested family to the server-issued legal action, then submits the strict
 * `{requestId,turnId,expectedVersion,actionId,amount?}` request. The response is
 * validated against the mandatory `CanonicalActionResultSchema` so a malformed
 * server result fails loudly instead of being hidden. Retries only on 429.
 */
export async function executeAction(
  app: FastifyInstance,
  token: string,
  tableId: string,
  requested: RequestedAction,
  maxRetries = 3
): Promise<CanonicalActionResult> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const observation = await getObservation(app, token, tableId);
    const payload = toCanonicalActionRequest(observation, requested);
    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/action`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload,
    });

    if (response.statusCode === 200) {
      return CanonicalActionResultSchema.parse(JSON.parse(response.body)) as CanonicalActionResult;
    }

    if (response.statusCode === 429) {
      const delay = 1000 + attempt * 500;
      lastError = new Error(`Rate limited on action: ${response.body} — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Failed to execute action: ${response.body}`);
  }
  throw lastError || new Error("Execute action failed after retries");
}

/**
 * Get table state
 */
export async function getTableState(
  app: FastifyInstance,
  token: string,
  tableId: string
): Promise<any> {
  const response = await app.inject({
    method: "GET",
    url: `/tables/${tableId}`,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get table state: ${response.body}`);
  }

  return JSON.parse(response.body).state;
}

/**
 * Get user balances
 */
export async function getUserBalances(
  app: FastifyInstance,
  userId: string
): Promise<{ main: number; inPlay: number }> {
  const balances = await app.financialManager.getChipBalances(userId);
  return {
    main: Number(balances.available),
    inPlay: Number(balances.inPlay + balances.tournament),
  };
}

/**
 * Stand from table (cash out)
 */
export async function standFromTable(
  app: FastifyInstance,
  token: string,
  tableId: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.inject({
      method: "POST",
      url: `/tables/${tableId}/stand`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (response.statusCode === 200) return;

    // The stand committed; only the lock release failed. Retry the idempotent
    // stand, which replays the stored cash-out instead of double-spending.
    if (response.statusCode === 500 && isPostCommitLockFailure(response.body)) {
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      continue;
    }

    throw new Error(`Failed to stand: ${response.body}`);
  }
  throw new Error("Failed to stand after retries");
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
