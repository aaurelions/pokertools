import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { asRedlockClient } from "../utils/redis-compatibility.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";
import { createNextHandWorker } from "./next-hand-handler.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([asRedlockClient(redis)], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});

const queues = createJobQueues(redis);
const manager = new GameManager(redis, redlock, queues, prisma);

/**
 * Next Hand Worker
 *
 * Starts the next hand after a delay following the previous hand's completion.
 * The authoritative decision (hand identity/street/winners/players/status) is
 * read from the database snapshot; Redis is not consulted. The Redis lock is
 * retained as optional coordination, but the DB CAS in `processAction` is the
 * sole authority and makes a race with a manual DEAL safe. The handler is
 * shared with acceptance via `next-hand-handler.ts`.
 */
const worker = createNextHandWorker(prisma, manager, redis, redlock);

worker.on("failed", (job, err) => {
  console.error(`❌ next-hand job ${job?.id} failed:`, err);
});

worker.on("closed", async () => {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.quit();
});

export default worker;
