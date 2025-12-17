import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PokerEngine, type Snapshot as EngineSnapshot } from "@pokertools/engine";
import { config } from "../config.js";

const redis = new Redis(config.REDIS_URL);
const prisma = new PrismaClient();

interface Snapshot extends EngineSnapshot {
  _version?: number;
}

/**
 * Timeout Worker
 *
 * Processes player timeouts with version checking to prevent race conditions.
 * When a player times out, they are automatically folded.
 */
const worker = new Worker(
  "player-timeout",
  async (job) => {
    const { tableId, playerId, expectedVersion } = job.data;

    // 1. Load state from Redis
    const stateJson = await redis.get(`table:${tableId}`);
    if (!stateJson) {
      console.warn(`⚠️  No state found for table ${tableId}`);
      return;
    }

    const snapshot: Snapshot = JSON.parse(stateJson);

    // 2. Version check prevents race condition
    if ((snapshot._version || 0) !== expectedVersion) {
      console.log(
        `⏭️  Skipping timeout for ${playerId} (version mismatch: expected ${expectedVersion}, got ${snapshot._version || 0})`
      );
      return;
    }

    // 3. Restore engine from snapshot
    const engine = PokerEngine.restore(snapshot);

    // 4. Execute timeout action (fold)
    try {
      engine.act({
        type: "TIMEOUT" as any,
        playerId,
      });

      // 5. Save new state
      const newSnapshot: Snapshot = engine.snapshot as any;
      newSnapshot._version = expectedVersion + 1;
      await redis.set(`table:${tableId}`, JSON.stringify(newSnapshot), "EX", 86400);

      // 6. Broadcast state update
      await redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: newSnapshot._version,
        })
      );

      console.log(`⏰ Player ${playerId} timed out at table ${tableId} and was folded`);
    } catch (error: any) {
      console.error(`❌ Failed to process timeout for ${playerId}:`, error.message);
    }
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ timeout job ${job?.id} failed:`, err);
});

export default worker;
