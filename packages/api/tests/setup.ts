import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "dotenv";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";
import { Redis } from "ioredis";

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
});

// Suppress console output during tests (only show on failures)
beforeEach(() => {
  console.log = () => {};
  console.info = () => {};
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
