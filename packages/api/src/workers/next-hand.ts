import { Worker } from "bullmq";
import { PrismaClient } from "../../generated/prisma/index.js";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { PokerEngine, type Snapshot as EngineSnapshot } from "@pokertools/engine";

const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL);
const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 100,
});

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
      lock = await redlock.acquire([`lock:table:${tableId}`], 3000);
    } catch (err) {
      console.log(`⏭️  Could not acquire lock for table ${tableId}, likely manually dealt`);
      return;
    }

    try {
      // 1. Load state from Redis
      const stateJson = await redis.get(`table:${tableId}`);
      if (!stateJson) {
        console.warn(`⚠️  No state found for table ${tableId}, skipping next hand`);
        return;
      }

      const snapshot: Snapshot = JSON.parse(stateJson);

      // 2. Check if already in a hand (manual DEAL happened)
      if (snapshot.street !== "SHOWDOWN" || !snapshot.winners) {
        console.log(`⏭️  Table ${tableId} already started next hand, skipping`);
        return;
      }

      // 3. Check if enough players to continue
      const activePlayers = snapshot.players.filter((p) => p !== null && p.stack > 0);
      if (activePlayers.length < 2) {
        console.log(`⏸️  Table ${tableId} has < 2 players, pausing game`);
        await prisma.table.update({
          where: { id: tableId },
          data: { status: "WAITING" },
        });
        return;
      }

      // 4. Restore engine and deal new hand
      const engine = PokerEngine.restore(snapshot);
      engine.deal();

      // 5. Save new state to Redis
      const newSnapshot: Snapshot = engine.snapshot as any;
      newSnapshot._version = (snapshot._version || 0) + 1;
      await redis.set(`table:${tableId}`, JSON.stringify(newSnapshot), "EX", 86400);

      // 6. Broadcast state update via Redis Pub/Sub
      await redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: newSnapshot._version,
        })
      );

      console.log(`✅ Auto-dealt next hand for table ${tableId}`);
    } finally {
      await lock.release();
    }
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ next-hand job ${job?.id} failed:`, err);
});

export default worker;
