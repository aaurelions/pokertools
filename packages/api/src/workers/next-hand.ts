import { Worker } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { asRedlockClient } from "../utils/redis-compatibility.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";
import { loadAuthoritativeTable } from "../services/game-repository.js";
import { ActionType } from "@pokertools/types";

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
 * The authoritative decision (street/winners/players/status) is read from the
 * database snapshot; Redis is not consulted. The Redis lock is retained as
 * optional coordination, but the DB CAS in `processAction` is the sole
 * authority and makes a race with a manual DEAL safe.
 */
const worker = new Worker(
  "next-hand",
  async (job) => {
    const { tableId } = job.data as { tableId: string };

    let lock;
    try {
      lock = await redlock.lock([`lock:table:${tableId}`], config.NEXT_HAND_LOCK_TTL_MS);
    } catch (err) {
      throw new Error(`Unable to acquire auto-deal lock for table ${tableId}`, { cause: err });
    }

    try {
      const record = await loadAuthoritativeTable(prisma, tableId);
      if (!record || !record.snapshot || record.status === "CLOSED") return;

      const snapshot = record.snapshot;
      // Already started next hand (manual DEAL happened) or hand not settled.
      if (snapshot.street !== "SHOWDOWN" || !snapshot.winners) {
        return;
      }

      const activePlayers = snapshot.players.filter((p) => p !== null && p.stack > 0);
      if (activePlayers.length < 2) {
        await prisma.table.updateMany({
          where: { id: tableId, status: { not: "CLOSED" } },
          data: { status: "WAITING" },
        });
        return;
      }

      await manager.processAction(tableId, { type: ActionType.DEAL }, "", {
        skipLock: true,
        expectedVersion: record.stateVersion,
      });

      console.log(`✅ Auto-dealt next hand for table ${tableId}`);
    } finally {
      await lock.unlock();
    }
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ next-hand job ${job?.id} failed:`, err);
});

worker.on("closed", async () => {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await prisma.$disconnect();
  await redis.quit();
});

export default worker;
