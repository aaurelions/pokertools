/**
 * BullMQ Workers
 *
 * This file imports and initializes all workers.
 * Workers run in the background to process async jobs.
 */

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import settleHandWorker from "./settle-hand.js";
import archiveHandWorker from "./archive-hand.js";
import nextHandWorker from "./next-hand.js";
import persistSnapshotWorker from "./persist-snapshot.js";
import timeoutWorker from "./timeout.js";
import createDepositMonitorWorker from "./deposit-monitor.js";

// Initialize deposit monitor worker (standalone mode)
const depositMonitorWorker = createDepositMonitorWorker();

console.log("🔧 BullMQ Workers initialized:");
console.log("   - settle-hand");
console.log("   - archive-hand");
console.log("   - next-hand");
console.log("   - persist-snapshot");
console.log("   - player-timeout");
console.log("   - deposit-monitor");

// Export workers for cleanup on shutdown
export const workers = [
  settleHandWorker,
  archiveHandWorker,
  nextHandWorker,
  persistSnapshotWorker,
  timeoutWorker,
  depositMonitorWorker,
];

// ============================================================================
// Schedule Deposit Monitor as Repeatable Job
// ============================================================================

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl);
const queue = new Queue("deposit-monitor", { connection: redis });

// Schedule deposit monitor to run every 15 seconds
(async () => {
  try {
    await queue.add(
      "deposit-monitor",
      {},
      {
        repeat: { every: 15000 }, // Check every 15 seconds
        jobId: "deposit-monitor-singleton", // Ensure only one cron exists
      }
    );
    console.log("✅ Deposit monitor scheduled: every 15 seconds");
  } catch (error) {
    console.error("❌ Failed to schedule deposit monitor:", error);
  }
})();

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("🛑 Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
