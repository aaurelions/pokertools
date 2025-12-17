/// <reference path="../../types/fastify.d.ts" />
import type { FastifyInstance } from "fastify";
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
      accounts: {
        create: [
          {
            currency: "USDC",
            type: "MAIN",
            balance: initialBalance,
          },
        ],
      },
    },
  });

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
    address: user.address,
    token,
    jti,
  };
}

/**
 * Clean up test user and all related data
 */
export async function cleanupTestUser(app: FastifyInstance, userId: string): Promise<void> {
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.ledgerEntry.deleteMany({
    where: { account: { userId } },
  });
  await app.prisma.account.deleteMany({ where: { userId } });
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

  // Add cleanup handlers
  cleanup.push(async () => {
    for (const user of users) {
      await cleanupTestUser(app, user.id);
    }
  });

  cleanup.push(async () => {
    await app.close();
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
  config: {
    name: string;
    mode: "CASH" | "TOURNAMENT";
    smallBlind: number;
    bigBlind: number;
    maxPlayers?: number;
    minBuyIn?: number;
    maxBuyIn?: number;
  }
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/tables",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      name: config.name,
      mode: config.mode,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      maxPlayers: config.maxPlayers ?? 6,
      minBuyIn: config.minBuyIn,
      maxBuyIn: config.maxBuyIn,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to create table: ${response.body}`);
  }

  const body = JSON.parse(response.body);
  return body.tableId;
}

/**
 * Buy in to a table
 */
export async function buyIn(
  app: FastifyInstance,
  token: string,
  tableId: string,
  amount: number,
  seat: number
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/tables/${tableId}/buy-in`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      amount: amount.toString(),
      seat,
      idempotencyKey: crypto.randomUUID(),
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to buy in: ${response.body}`);
  }
}

/**
 * Execute a game action
 */
export async function executeAction(
  app: FastifyInstance,
  token: string,
  tableId: string,
  action: {
    type: string;
    amount?: number;
    [key: string]: any;
  }
): Promise<any> {
  const response = await app.inject({
    method: "POST",
    url: `/tables/${tableId}/action`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: action,
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to execute action: ${response.body}`);
  }

  return JSON.parse(response.body);
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
  return await app.financialManager.getBalances(userId);
}

/**
 * Stand from table (cash out)
 */
export async function standFromTable(
  app: FastifyInstance,
  token: string,
  tableId: string
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/tables/${tableId}/stand`,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to stand: ${response.body}`);
  }
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
