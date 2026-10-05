import { Redis } from "ioredis";
import Redlock from "redlock";
import pino from "pino";
import { config } from "../config.js";
import { asRedlockClient } from "../utils/redis-compatibility.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";
import { createTournamentReconcileWorker } from "./tournament-reconcile-handler.js";

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
const logger = pino({ name: "tournament-reconcile" });

/**
 * Tournament Reconcile Worker
 *
 * Consumes the durable tournament-director intent committed with every
 * tournament hand completion (ACTION/DEAL/TIMEOUT) and runs the existing
 * authoritative director. The handler is shared with acceptance via
 * `tournament-reconcile-handler.ts`. The outbox row is acknowledged only when
 * the pass converges, so a crash or transient failure is retried with backoff
 * and recovered on restart.
 */
const worker = createTournamentReconcileWorker(prisma, manager, redis, redlock, logger);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, error: err }, "tournament-reconcile job failed");
});

worker.on("closed", async () => {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.quit();
});

export default worker;
