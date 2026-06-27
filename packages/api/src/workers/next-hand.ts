import { Worker } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { PokerEngine, type Snapshot as EngineSnapshot } from "@pokertools/engine";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as any], {
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
        await redis.set(`table:${tableId}`, stateJson, "EX", 86400);
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

      // Restore engine and deal new hand
      const engine = PokerEngine.restore(snapshot);
      engine.deal();

      // Save new state to Redis with the same optimistic version guard as
      // player actions. This prevents the auto-dealer from overwriting a
      // manually-dealt hand that landed after our initial read.
      const newSnapshot: Snapshot = engine.snapshot as any;
      const expectedVersion = snapshot._version || 0;
      newSnapshot._version = expectedVersion + 1;

      const updateResult = (await redis.eval(
        `
        local key = KEYS[1]
        local expected = tonumber(ARGV[1])
        local newValue = ARGV[2]
        local ttl = tonumber(ARGV[3])
        local current = redis.call('GET', key)
        if not current then
          return {err = 'STATE_NOT_FOUND'}
        end
        local decoded = cjson.decode(current)
        local currentVersion = tonumber(decoded['_version'] or 0)
        if currentVersion ~= expected then
          return 0
        end
        redis.call('SET', key, newValue, 'EX', ttl)
        return 1
        `,
        1,
        `table:${tableId}`,
        expectedVersion.toString(),
        JSON.stringify(newSnapshot),
        "86400"
      )) as number;

      if (updateResult !== 1) {
        console.log(`⏭️  Table ${tableId} changed concurrently, skipping auto-deal write`);
        return;
      }

      await prisma.table.update({
        where: { id: tableId },
        data: { state: JSON.stringify(newSnapshot) },
      });

      await redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: newSnapshot._version,
          timestamp: Date.now(),
        })
      );

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

export default worker;
