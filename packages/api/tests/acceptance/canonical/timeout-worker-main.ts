/**
 * Standalone timeout-worker entry point for the canonical race acceptance.
 *
 * Runs the REAL `GameManager` timeout path in a SEPARATE OS process using the
 * private PostgreSQL Prisma client generated for this suite. It is
 * intentionally limited to `player-timeout` so the race test does not start
 * RPC/finance workers. `GameManager` / `game-repository` only import Prisma
 * types, so this process never touches the shared SQLite client.
 */

import { Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { PrismaPg } from "@prisma/adapter-pg";
import { ActionType } from "@pokertools/types";
import { config } from "../../../src/config.js";
import { createJobQueues } from "../../../src/plugins/queue.js";
import { GameManager } from "../../../src/services/game-manager.js";
import { PrismaClient } from "../../../.runtime/generated/prisma/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the timeout worker");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as unknown as Redlock.CompatibleRedisClient], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});
const queues = createJobQueues(redis as unknown as ConnectionOptions);
const manager = new GameManager(redis, redlock, queues, prisma);

const worker = new Worker(
  "player-timeout",
  async (job) => {
    const { tableId, playerId, expectedVersion } = job.data as {
      tableId: string;
      playerId: string;
      expectedVersion: number;
    };
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("Timeout job requires a non-negative expectedVersion");
    }
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { status: true },
    });
    if (!table || table.status === "CLOSED") return;
    await manager.processAction(tableId, { type: ActionType.TIMEOUT, playerId }, playerId, {
      expectedVersion,
    });
  },
  { connection: redis as never }
);

worker.on("failed", (job, error) => {
  console.error(`timeout job ${job?.id} failed:`, error.message);
});

// eslint-disable-next-line no-console
console.log("canonical-timeout-worker:started");
