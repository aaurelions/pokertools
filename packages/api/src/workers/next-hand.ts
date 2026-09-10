import { Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { type Snapshot as EngineSnapshot } from "@pokertools/engine";
import { createPrismaClient } from "../utils/prisma-client.js";

import { createJobQueues } from "../plugins/queue.js";
import { GameManager } from "../services/game-manager.js";
import { ActionType } from "@pokertools/types";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as any], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});

const queues = createJobQueues(redis as unknown as ConnectionOptions);
const manager = new GameManager(redis, redlock, queues, prisma);

interface Snapshot extends EngineSnapshot {
  _version?: number;
}

/**
 * Next Hand Worker
 *
 * Starts the next hand after a delay following the previous hand's completion.
 * Uses locking to prevent race conditions with manual DEAL actions.
 */
const worker = new Worker(
  "next-hand",
  async (job) => {
    const { tableId } = job.data;

    // Try to acquire lock, but don't retry too aggressively
    // If manual DEAL already happened, we can skip
    let lock;
    try {
      lock = await redlock.acquire([`lock:table:${tableId}`], config.NEXT_HAND_LOCK_TTL_MS);
    } catch (err) {
      throw new Error(`Unable to acquire auto-deal lock for table ${tableId}`, { cause: err });
    }

    try {
      // Load state from Redis, recovering from durable DB snapshot if Redis expired
      let stateJson = await redis.get(`table:${tableId}`);
      if (!stateJson) {
        const table = await prisma.table.findUnique({
          where: { id: tableId },
          select: { state: true },
        });
        if (!table?.state) {
          console.warn(`⚠️  No state found for table ${tableId}, skipping next hand`);
          return;
        }
        stateJson = typeof table.state === "string" ? table.state : JSON.stringify(table.state);
        await redis.set(`table:${tableId}`, stateJson, "EX", config.TABLE_REDIS_TTL_SECONDS);
      }

      const snapshot: Snapshot = JSON.parse(stateJson);

      // Check if already in a hand (manual DEAL happened)
      if (snapshot.street !== "SHOWDOWN" || !snapshot.winners) {
        console.log(`⏭️  Table ${tableId} already started next hand, skipping`);
        return;
      }

      // Check if enough players to continue
      const activePlayers = snapshot.players.filter((p) => p !== null && p.stack > 0);
      if (activePlayers.length < 2) {
        console.log(`⏸️  Table ${tableId} has < 2 players, pausing game`);
        await prisma.table.update({
          where: { id: tableId },
          data: { status: "WAITING" },
        });
        return;
      }

      // Reuse normal action side effects, including the first player's timeout
      // and settlement if the blinds immediately cause an all-in showdown.
      await manager.processAction(tableId, { type: ActionType.DEAL }, "", {
        skipLock: true,
        expectedVersion: snapshot._version ?? 0,
      });

      console.log(`✅ Auto-dealt next hand for table ${tableId}`);
    } finally {
      await lock.release();
    }
  },
  { connection: redis as any }
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
