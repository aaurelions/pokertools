/**
 * Standalone timeout-worker entry point for the canonical race acceptance.
 *
 * Runs the REAL `GameManager` timeout path in a SEPARATE OS process using the
 * private PostgreSQL Prisma client generated for this suite. It is
 * intentionally limited to `player-timeout` so the race test does not start
 * RPC/finance workers. `GameManager` / `game-repository` only import Prisma
 * types, so this process never touches the shared SQLite client.
 */

import type { ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../../../src/config.js";
import { createJobQueues } from "../../../src/plugins/queue.js";
import { GameManager } from "../../../src/services/game-manager.js";
import { PrismaClient } from "../../../.runtime/generated/prisma/index.js";
import { createPlayerTimeoutWorker } from "../../../src/workers/timeout-handler.js";
import { recoverGameOutbox } from "../../../src/services/game-outbox.js";
import { registerHooks } from "node:module";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the timeout worker");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redlock = new Redlock([redis as unknown as Redlock.CompatibleRedisClient], {
  driftFactor: config.REDLOCK_DRIFT_FACTOR,
  retryCount: config.REDLOCK_RETRY_COUNT,
  retryDelay: config.REDLOCK_RETRY_DELAY_MS,
  retryJitter: config.REDLOCK_RETRY_DELAY_MS / 2,
});
const queues = createJobQueues(redis as unknown as ConnectionOptions);
const manager = new GameManager(redis, redlock, queues, prisma);

const worker = createPlayerTimeoutWorker(prisma, manager, redis);
await worker.waitUntilReady();
const wantsHandWorkers = process.env.POKERTOOLS_ACCEPTANCE_HAND_WORKERS === "true";
const wantsTournamentWorkers = process.env.POKERTOOLS_ACCEPTANCE_TOURNAMENT_WORKERS === "true";
if (wantsHandWorkers || wantsTournamentWorkers) {
  // Production worker modules use the same schema with this suite's private PG
  // generated client. No handler, ledger, queue or infrastructure is replaced.
  const sharedClient = new URL("../../../generated/prisma/index.js", import.meta.url).href;
  const privateClient = new URL("../../../.runtime/generated/prisma/index.js", import.meta.url)
    .href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      return resolved.url.split("?")[0] === sharedClient
        ? { url: privateClient, shortCircuit: true }
        : resolved;
    },
  });
}
if (wantsHandWorkers) {
  for (const path of [
    "../../../src/workers/settle-hand.js",
    "../../../src/workers/archive-hand.js",
  ]) {
    const { default: handWorker } = await import(path);
    handWorker.on("completed", (job: { id: string }) =>
      console.log(`canonical-hand-worker:completed:${job.id}`)
    );
    handWorker.on("failed", (job: { id: string }, error: Error) =>
      console.log(`canonical-hand-worker:failed:${job.id}:${error.message}`)
    );
    await handWorker.waitUntilReady();
  }
}
if (wantsTournamentWorkers) {
  // Real next-hand and durable tournament-director workers (production
  // factories, shared with process wiring), for tournament/competition
  // completion regressions.
  const { createNextHandWorker } = await import("../../../src/workers/next-hand-handler.js");
  const nextHand = createNextHandWorker(prisma, manager, redis, redlock);
  nextHand.on("completed", (job: { id: string }) =>
    console.log(`canonical-tournament-worker:next-hand:completed:${job.id}`)
  );
  nextHand.on("failed", (job: { id: string }, error: Error) =>
    console.log(`canonical-tournament-worker:next-hand:failed:${job.id}:${error.message}`)
  );
  await nextHand.waitUntilReady();

  const { createTournamentReconcileWorker } =
    await import("../../../src/workers/tournament-reconcile-handler.js");
  const director = createTournamentReconcileWorker(prisma, manager, redis, redlock, {
    warn: (obj: unknown, msg?: string) =>
      console.log(`canonical-tournament-worker:director:warn:${JSON.stringify(obj)}:${msg ?? ""}`),
  });
  director.on("completed", (job: { id: string }) =>
    console.log(`canonical-tournament-worker:director:completed:${job.id}`)
  );
  director.on("failed", (job: { id: string }, error: Error) =>
    console.log(`canonical-tournament-worker:director:failed:${job.id}:${error.message}`)
  );
  await director.waitUntilReady();
}
await recoverGameOutbox(prisma, queues, redis);
setInterval(
  () =>
    void recoverGameOutbox(prisma, queues, redis).catch((error: Error) => {
      console.error("outbox recovery failed:", error.message);
    }),
  100
);
worker.on("completed", (job) => console.log(`canonical-timeout-worker:completed:${job.id}`));

worker.on("failed", (job, error) => {
  console.error(`timeout job ${job?.id} failed:`, error.message);
});

// eslint-disable-next-line no-console
console.log("canonical-timeout-worker:started");
