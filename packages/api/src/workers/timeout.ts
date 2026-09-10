import { Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { ActionType } from "@pokertools/types";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as any], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});
const prisma = createPrismaClient();
const queues = createJobQueues(redis as unknown as ConnectionOptions);
const manager = new GameManager(redis, redlock, queues, prisma);

// Use the same persistence, settlement and scheduling path as player actions.
// Lock contention fails the job so BullMQ retries instead of losing the timeout.
const worker = new Worker(
  "player-timeout",
  async (job) => {
    const { tableId, playerId, expectedVersion } = job.data;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("Timeout job requires a non-negative expectedVersion");
    }
    await manager.processAction(tableId, { type: ActionType.TIMEOUT, playerId }, playerId, {
      expectedVersion,
    });
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  console.error(`Timeout job ${job?.id} failed:`, err);
});
worker.on("closed", async () => {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.quit();
});

export default worker;
