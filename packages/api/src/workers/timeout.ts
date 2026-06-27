import { Worker } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { PokerEngine, type Snapshot as EngineSnapshot } from "@pokertools/engine";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as any], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 100,
});
const prisma = createPrismaClient();

interface Snapshot extends EngineSnapshot {
  _version?: number;
}

/**
 * Timeout Worker
 *
 * Processes player timeouts with Redlock concurrency and version checking
 * to prevent race conditions. When a player times out, they are automatically
 * folded. Uses the same concurrency pattern as normal actions (GameManager).
 */
const worker = new Worker(
  "player-timeout",
  async (job) => {
    const { tableId, playerId, expectedVersion } = job.data;

    // Acquire distributed lock (same pattern as GameManager.processAction)
    const lockTTL = process.env.NODE_ENV === "test" ? 15000 : 10000;
    let lock;
    try {
      lock = await redlock.acquire([`lock:table:${tableId}`], lockTTL);
    } catch {
      console.log(
        `⏭️  Could not acquire lock for table ${tableId} (timeout for ${playerId}), skipping`
      );
      return;
    }

    const lockStartTime = Date.now();
    const lockExtendThreshold = lockTTL * 0.6;

    try {
      // Load state from Redis
      const stateJson = await redis.get(`table:${tableId}`);
      if (!stateJson) {
        console.warn(`⚠️  No state found for table ${tableId}`);
        return;
      }

      const snapshot: Snapshot = JSON.parse(stateJson);

      // Version check prevents race condition
      if ((snapshot._version || 0) !== expectedVersion) {
        console.log(
          `⏭️  Skipping timeout for ${playerId} (version mismatch: expected ${expectedVersion}, got ${snapshot._version || 0})`
        );
        return;
      }

      // Restore engine from snapshot
      const engine = PokerEngine.restore(snapshot);

      // Execute timeout action (fold)
      engine.act({
        type: "TIMEOUT" as any,
        playerId,
      });

      // Check if we need to extend lock before write
      if (Date.now() - lockStartTime > lockExtendThreshold) {
        try {
          await lock.extend(lockTTL);
        } catch {
          throw new Error("Lock expired during timeout processing - operation aborted");
        }
      }

      // Save new state with optimistic version guard
      const newSnapshot: Snapshot = engine.snapshot as any;
      const currentVersion = expectedVersion + 1;
      newSnapshot._version = currentVersion;

      const setScript = `
        local key = KEYS[1]
        local expectedVersion = tonumber(ARGV[1])
        local newValue = ARGV[2]
        local ttl = tonumber(ARGV[3])

        local current = redis.call('GET', key)
        if current == false then
          return redis.error_reply('Table state not found')
        end

        if current == '' then
          return redis.error_reply('Table state is empty')
        end

        local ok, currentData = pcall(cjson.decode, current)
        if not ok then
          return redis.error_reply('Table state is corrupted (invalid JSON)')
        end

        if type(currentData) ~= 'table' then
          return redis.error_reply('Table state is not a valid object')
        end

        local currentVersion = currentData._version or 0

        if currentVersion ~= expectedVersion then
          return redis.error_reply('Version mismatch: expected ' .. expectedVersion .. ', got ' .. currentVersion)
        end

        redis.call('SET', key, newValue, 'EX', ttl)
        return 'OK'
      `;

      try {
        await redis.eval(
          setScript,
          1,
          `table:${tableId}`,
          expectedVersion.toString(),
          JSON.stringify(newSnapshot),
          "86400"
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("Version mismatch")) {
          console.log(
            `⏭️  Version guard blocked stale timeout for ${playerId} at table ${tableId}`
          );
          return;
        }
        throw err;
      }

      // Broadcast lightweight state update
      await redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: currentVersion,
          timestamp: Date.now(),
        })
      );

      console.log(`⏰ Player ${playerId} timed out at table ${tableId} and was folded`);
    } finally {
      await lock.release();
    }
  },
  { connection: redis as any }
);

worker.on("failed", (job, err) => {
  console.error(`❌ timeout job ${job?.id} failed:`, err);
});

export default worker;
