import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { JobQueues } from "../plugins/queue.js";

/**
 * Durable transactional outbox.
 *
 * Side-effect intents (queue jobs and pubsub notifications) are written in the
 * same DB transaction as the game mutation. Dispatch is a best-effort
 * post-commit step: a Redis/BullMQ failure never turns an already-accepted game
 * mutation into a failed response, and the PENDING row remains for recovery.
 *
 * `dedupeKey` is deterministic and table/hand/version scoped, so re-dispatch
 * after a crash is logically idempotent (BullMQ also dedupes by `jobId`).
 */

export type OutboxKind = "settle-hand" | "archive-hand" | "next-hand" | "player-timeout" | "pubsub";

export interface OutboxIntent {
  kind: OutboxKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

export interface OutboxRow {
  id: string;
  tableId: string;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  status: string;
  attempts: number;
  availableAt: Date;
}

type OutboxClient = PrismaClient | Prisma.TransactionClient;

/** Insert intents idempotently (no-op when the deterministic key already exists). */
export async function writeOutboxIntents(
  tx: OutboxClient,
  tableId: string,
  intents: readonly OutboxIntent[]
): Promise<void> {
  for (const intent of intents) {
    await tx.gameOutbox.upsert({
      where: { dedupeKey: intent.dedupeKey },
      create: {
        tableId,
        kind: intent.kind,
        dedupeKey: intent.dedupeKey,
        payload: intent.payload as Prisma.InputJsonValue,
        availableAt: intent.availableAt ?? new Date(),
      },
      update: {},
    });
  }
}

function jobOptions(kind: string, availableAt: Date): Record<string, unknown> {
  const delay = Math.max(0, availableAt.getTime() - Date.now());
  if (kind === "settle-hand") {
    return { attempts: 10, backoff: { type: "exponential", delay: 500 }, delay };
  }
  return { delay };
}

async function dispatchRow(queues: JobQueues, redis: Redis, row: OutboxRow): Promise<void> {
  if (row.kind === "pubsub") {
    const payload = row.payload as { channel?: string } & Record<string, unknown>;
    const channel = payload.channel ?? `pubsub:table:${row.tableId}`;
    await redis.publish(channel, JSON.stringify(payload));
    return;
  }

  const queue = queues[row.kind as keyof JobQueues] as Queue | undefined;
  if (!queue) throw new Error(`Unknown outbox kind: ${row.kind}`);
  await queue.add(row.kind, row.payload, {
    jobId: row.dedupeKey,
    ...jobOptions(row.kind, row.availableAt),
  });
}

/** Mark a single row dispatched, or record the dispatch failure for retry. */
export async function dispatchOutboxRow(
  prisma: PrismaClient,
  queues: JobQueues,
  redis: Redis,
  row: OutboxRow
): Promise<{ dispatched: boolean; error?: string }> {
  try {
    await dispatchRow(queues, redis, row);
    await prisma.gameOutbox.update({
      where: { id: row.id },
      data: { status: "DISPATCHED", attempts: { increment: 1 }, lastError: null },
    });
    return { dispatched: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.gameOutbox
      .update({
        where: { id: row.id },
        data: { status: "FAILED", attempts: { increment: 1 }, lastError: message },
      })
      .catch(() => undefined);
    return { dispatched: false, error: message };
  }
}

/**
 * Dispatch durable intents. Defaults to every due PENDING row so a restarted
 * process (or a process that never had Redis) recovers committed side effects.
 * Never throws: callers must be able to ignore Redis failures.
 */
export async function dispatchPendingOutbox(
  prisma: PrismaClient,
  queues: JobQueues,
  redis: Redis,
  options: { limit?: number; tableId?: string } = {}
): Promise<{ dispatched: number; failed: number }> {
  const rows = await prisma.gameOutbox.findMany({
    where: {
      status: "PENDING",
      availableAt: { lte: new Date() },
      ...(options.tableId ? { tableId: options.tableId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
  });

  let dispatched = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await dispatchOutboxRow(prisma, queues, redis, row);
    if (result.dispatched) dispatched += 1;
    else failed += 1;
  }
  return { dispatched, failed };
}

/** Retry rows previously marked FAILED (e.g. after Redis recovers). */
export async function requeueFailedOutbox(prisma: PrismaClient, maxAttempts = 25): Promise<number> {
  const result = await prisma.gameOutbox.updateMany({
    where: { status: "FAILED", attempts: { lt: maxAttempts } },
    data: { status: "PENDING", availableAt: new Date() },
  });
  return result.count;
}
