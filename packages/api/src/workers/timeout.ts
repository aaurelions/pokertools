import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { asRedlockClient } from "../utils/redis-compatibility.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";
import { createPlayerTimeoutWorker } from "./timeout-handler.js";

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([asRedlockClient(redis)], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});
const prisma = createPrismaClient();
const queues = createJobQueues(redis);
const manager = new GameManager(redis, redlock, queues, prisma);

// Use the same persistence, settlement and scheduling path as player actions.
// Lock contention fails the job so BullMQ retries instead of losing the timeout.
const worker = createPlayerTimeoutWorker(prisma, manager, redis);

worker.on("failed", (job, err) => {
  console.error(`Timeout job ${job?.id} failed:`, err);
});
worker.on("closed", async () => {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.quit();
});

export default worker;
