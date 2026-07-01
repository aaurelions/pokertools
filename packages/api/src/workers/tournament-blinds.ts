import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import Redlock from "redlock";
import { config } from "../config.js";
import { GameManager } from "../services/game-manager.js";
import { createPrismaClient } from "../utils/prisma-client.js";
import { PrismaClient } from "../../generated/prisma/index.js";
import type { Action } from "@pokertools/engine";
import type { JobQueues } from "../plugins/queue.js";

const INTERVAL_MS = config.TOURNAMENT_BLIND_INTERVAL_MS;
const gameQueueNames = [
  "settle-hand",
  "archive-hand",
  "next-hand",
  "persist-snapshot",
  "player-timeout",
  "tournament-blinds",
] as const;

export interface TournamentBlindsLogger {
  info: (msg: unknown, ...args: unknown[]) => void;
  warn: (msg: unknown, ...args: unknown[]) => void;
  error: (msg: unknown, ...args: unknown[]) => void;
}

/**
 * Scan all RUNNING tournaments and advance blinds for any that have exceeded
 * the configured blind interval since their last advance (or start).
 *
 * Exported for testability so integration tests can drive the logic directly
 * without needing the full BullMQ worker lifecycle.
 *
 * @param intervalMs Optional override for the blind interval (defaults to config).
 *                   Useful for tests where the envalid config is frozen.
 */
export async function scanAndAdvanceTournamentBlinds(
  prisma: PrismaClient,
  redis: Redis,
  logger: TournamentBlindsLogger,
  intervalMs?: number
): Promise<{ advanced: string[]; skipped: string[] }> {
  const effectiveInterval = intervalMs ?? INTERVAL_MS;

  const now = new Date();
  const cutoff = new Date(now.getTime() - effectiveInterval);

  const runningTournaments = await prisma.tournament.findMany({
    where: { status: "RUNNING" },
  });

  const advanced: string[] = [];
  const skipped: string[] = [];

  if (runningTournaments.length === 0) return { advanced, skipped };

  const redlock = new Redlock([redis as any], {
    driftFactor: 0.01,
    retryCount: 1,
    retryDelay: 50,
  });

  const jobQueues = Object.fromEntries(
    gameQueueNames.map((name) => [name, new Queue(name, { connection: redis as any })])
  ) as JobQueues;

  const gameManager = new GameManager(redis, redlock, jobQueues, prisma);

  try {
    for (const tournament of runningTournaments) {
      const lastAdvance = tournament.lastBlindAdvancedAt ?? tournament.startedAt;
      if (lastAdvance && lastAdvance.getTime() > cutoff.getTime()) {
        skipped.push(tournament.id);
        continue;
      }

      const lockKey = `lock:tournament-blinds:${tournament.id}`;

      let lock;
      try {
        lock = await redlock.acquire([lockKey], 15000);
      } catch {
        logger.warn(
          { tournamentId: tournament.id },
          "Could not acquire tournament blinds lock, skipping"
        );
        skipped.push(tournament.id);
        continue;
      }

      try {
        const fresh = await prisma.tournament.findUnique({
          where: { id: tournament.id },
          select: {
            status: true,
            creatorId: true,
            lastBlindAdvancedAt: true,
            startedAt: true,
          },
        });

        if (!fresh || fresh.status !== "RUNNING") {
          skipped.push(tournament.id);
          continue;
        }

        const freshLastAdvance = fresh.lastBlindAdvancedAt ?? fresh.startedAt;
        if (freshLastAdvance && freshLastAdvance.getTime() > cutoff.getTime()) {
          skipped.push(tournament.id);
          continue;
        }

        const activeTables = await prisma.table.findMany({
          where: { tournamentId: tournament.id, status: "ACTIVE" },
          select: { id: true },
        });

        if (activeTables.length === 0) {
          skipped.push(tournament.id);
          continue;
        }

        for (const table of activeTables) {
          try {
            await gameManager.processAction(
              table.id,
              { type: "NEXT_BLIND_LEVEL" } as Action,
              fresh.creatorId,
              { skipIdentity: true }
            );
          } catch (error) {
            logger.error(
              { tournamentId: tournament.id, tableId: table.id, error },
              "Failed to advance blinds on tournament table"
            );
          }
        }

        await prisma.tournament.update({
          where: { id: tournament.id },
          data: { lastBlindAdvancedAt: now },
        });

        logger.info(
          { tournamentId: tournament.id, tableCount: activeTables.length },
          "Advanced tournament blinds"
        );
        advanced.push(tournament.id);
      } finally {
        await lock.release().catch(() => undefined);
      }
    }
  } finally {
    await Promise.all(Object.values(jobQueues).map((queue) => queue.close()));
  }

  return { advanced, skipped };
}

/**
 * Create Tournament Blinds Worker (BullMQ)
 *
 * Periodically scans RUNNING tournaments and advances blind levels when the
 * configured interval has elapsed since the last advance (or tournament start).
 */
export function createTournamentBlindsWorker(
  prisma: PrismaClient,
  redis: Redis,
  logger: TournamentBlindsLogger
): Worker {
  const worker = new Worker(
    "tournament-blinds",
    async () => {
      await scanAndAdvanceTournamentBlinds(prisma, redis, logger);
    },
    {
      connection: redis as any,
      limiter: {
        max: 1,
        duration: 1000,
      },
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err }, "tournament-blinds job failed");
  });

  return worker;
}

export async function createStandaloneWorker(): Promise<Worker> {
  const prisma = createPrismaClient();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const { default: pino } = await import("pino");
  const logger = pino({
    level: config.LOG_LEVEL || "info",
    transport:
      config.NODE_ENV === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss Z",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  });

  return createTournamentBlindsWorker(prisma, redis, logger);
}

export default createStandaloneWorker;
