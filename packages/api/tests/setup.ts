import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "dotenv";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";
import { Redis } from "ioredis";
import { createId } from "@paralleldrive/cuid2";
import { createPrismaClient } from "../src/utils/prisma-client.js";

// Load test environment
config({ path: resolve(__dirname, "../.env.test"), quiet: true });

if (process.env.DATABASE_URL?.startsWith("file:")) {
  let dbPath = process.env.DATABASE_URL.replace(/^file:/, "").replace(/^\.\//, "");

  if (dbPath.startsWith("packages/api/")) {
    dbPath = dbPath.replace(/^packages\/api\//, "");
  }

  if (!dbPath.startsWith("/")) {
    dbPath = resolve(__dirname, "../prisma", dbPath);
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  process.env.DATABASE_URL = `file:${dbPath}`;
}

let testRedis: Redis;

/**
 * Ensure the system HOUSE user and its ledger accounts exist in the test
 * database. Tournament registration/settlement depend on these accounts for
 * double-entry escrow accounting. This replaces the production `npm run seed`
 * step in the self-contained test environment.
 */
async function ensureHouseUser(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    let houseUser = await prisma.user.findUnique({
      where: { username: "HOUSE" },
    });

    if (!houseUser) {
      houseUser = await prisma.user.create({
        data: {
          id: createId(),
          username: "HOUSE",
          address: "0x0000000000000000000000000000000000000000",
          role: "ADMIN",
        },
      });
    }

    await prisma.account.upsert({
      where: {
        userId_currency_type: {
          userId: houseUser.id,
          currency: "USDC",
          type: "MAIN",
        },
      },
      create: {
        userId: houseUser.id,
        currency: "USDC",
        type: "MAIN",
        balance: 0,
      },
      update: {},
    });

    for (const type of ["HOUSE_RESERVE", "TOURNAMENT_ESCROW"] as const) {
      await prisma.account.upsert({
        where: {
          userId_currency_type: {
            userId: houseUser.id,
            currency: "USDC",
            type,
          },
        },
        create: {
          userId: houseUser.id,
          currency: "USDC",
          type,
          balance: 0,
        },
        update: {},
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Suppress harmless "Connection is closed" errors from BullMQ's ioredis
// that fire as unhandled rejections during worker/queue cleanup.
function suppressClosedError(reason: unknown) {
  if (reason instanceof Error && reason.message.includes("Connection is closed")) return;
  console.error("Unhandled rejection in test:", reason);
}

process.on("unhandledRejection", suppressClosedError);

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;

beforeAll(async () => {
  // Connect to test Redis instance
  testRedis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");

  // Flush test Redis database before tests to ensure clean state
  // DO NOT flush in afterAll to avoid race conditions between test files
  await testRedis.flushdb();

  // Seed the HOUSE user and system accounts. Tournament registration and
  // settlement routes require these for double-entry escrow bookkeeping.
  await ensureHouseUser();
});

// Suppress console output during tests (only show on failures)
beforeEach(async () => {
  console.log = () => {};
  console.info = () => {};

  // Clear risk/velocity tracking keys from Redis between tests
  // to prevent cross-test rate limiting contamination.
  // Risk keys follow the pattern risk:* and use zset scoring.
  try {
    const keys = await testRedis.keys("risk:*");
    if (keys.length > 0) {
      await testRedis.del(...keys);
    }
  } catch {
    // Silently ignore if Redis isn't available at this point
  }
});

afterEach(() => {
  // Restore console after each test
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
});

afterAll(async () => {
  // Restore console
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;

  process.removeListener("unhandledRejection", suppressClosedError);

  // Close test Redis connection
  // NOTE: We do NOT call flushdb() here to avoid race conditions
  // where one test file's cleanup deletes another test file's tables.
  // Redis is flushed in beforeAll to ensure clean state at start.
  if (testRedis) {
    if (testRedis.status !== "end") {
      await testRedis.quit().catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
          throw error;
        }
      });
    }
  }
});
