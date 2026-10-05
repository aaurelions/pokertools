import type { Job, Queue } from "bullmq";
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
  if (kind === "settle-hand" || kind === "player-timeout") {
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
    // BullMQ forbids ':' in custom ids. The upserted row id is stable across
    // retries and uniquely represents the deterministic PostgreSQL dedupe key.
    jobId: row.id,
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
    await prisma.gameOutbox.updateMany({
      where: { id: row.id, status: { not: "COMPLETED" } },
      data: { status: "DISPATCHED", attempts: { increment: 1 }, lastError: null },
    });
    return { dispatched: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.gameOutbox
      .updateMany({
        where: { id: row.id, status: { not: "COMPLETED" } },
        data: { status: "FAILED", attempts: { increment: 1 }, lastError: message },
      })
      .catch(() => undefined);
    return { dispatched: false, error: message };
  }
}

/**
 * Dispatch durable intents. Queued PENDING rows retain their scheduled delay;
 * pubsub PENDING rows are published only when due. A restarted
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
      // Future queue intents are dispatched now with their original delay.
      // Only pubsub must wait until availableAt (publish has no delay option).
      OR: [{ kind: { not: "pubsub" } }, { availableAt: { lte: new Date() } }],
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
    data: { status: "PENDING" },
  });
  return result.count;
}

/** Queue data is only transport. Execute the committed PostgreSQL payload and
 * acknowledge it durably AFTER the idempotent handler completes. A crash before
 * acknowledgement may replay the handler, never lose its obligation.
 */
export function durableOutboxProcessor<T>(
  prisma: PrismaClient,
  kind: OutboxKind,
  execute: (payload: T) => Promise<unknown>
): (job: Job) => Promise<unknown> {
  return async (job) => {
    const row = await prisma.gameOutbox.findUnique({ where: { id: job.id! } });
    if (!row || row.kind !== kind)
      throw new Error("Queue job requires its committed outbox intent");
    if (row.status === "COMPLETED") return;
    if (Date.now() < row.availableAt.getTime()) throw new Error("Outbox deadline has not elapsed");
    const result = await execute(row.payload as T);
    await prisma.gameOutbox.update({
      where: { id: row.id },
      data: { status: "COMPLETED", lastError: null },
    });
    return result;
  };
}

/** Restore unacknowledged queue obligations after Redis loss. Completion is
 * PostgreSQL-owned; completed handlers are idempotent if acknowledgement raced
 * a crash. Stale timeout versions are retired rather than replayed forever.
 */
export async function recoverGameOutbox(
  prisma: PrismaClient,
  queues: JobQueues,
  redis: Redis
): Promise<{ dispatched: number; failed: number }> {
  await requeueFailedOutbox(prisma);
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.gameOutbox.findMany({
      where: {
        status: "DISPATCHED",
        kind: { not: "pubsub" },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 100,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const queue = queues[row.kind as keyof JobQueues];
      if (!queue) continue;
      if (row.kind === "player-timeout") {
        const payload = row.payload as {
          expectedVersion?: number;
          handId?: unknown;
          anchorEventSeq?: unknown;
        };
        // A semantic (owned) lease is retired only by the manager's ownership
        // validation when it actually runs. Its legacy version necessarily
        // advances across benign blind levels, so a version mismatch alone must
        // never discard it during recovery.
        const ownedLease =
          typeof payload.handId === "string" &&
          payload.handId.length > 0 &&
          Number.isSafeInteger(payload.anchorEventSeq) &&
          (payload.anchorEventSeq as number) >= 1;
        const table = await prisma.table.findUnique({
          where: { id: row.tableId },
          select: { stateVersion: true, status: true },
        });
        if (
          !table ||
          table.status === "CLOSED" ||
          (!ownedLease && payload.expectedVersion !== table.stateVersion)
        ) {
          await prisma.gameOutbox.updateMany({
            where: { id: row.id, status: "DISPATCHED" },
            data: { status: "COMPLETED" },
          });
          continue;
        }
      }
      const job = await queue.getJob(row.id);
      if (job) {
        const state = await job.getState();
        if (state === "completed") {
          await prisma.gameOutbox.updateMany({
            where: { id: row.id, status: "DISPATCHED" },
            data: { status: "COMPLETED" },
          });
        } else if (state === "failed") {
          if (row.attempts >= 25) {
            await prisma.gameOutbox.updateMany({
              where: { id: row.id, status: "DISPATCHED" },
              data: { status: "FAILED", lastError: "JOB_EXECUTION_FAILED" },
            });
          } else {
            await job.retry("failed");
            await prisma.gameOutbox.updateMany({
              where: { id: row.id, status: "DISPATCHED" },
              data: { attempts: { increment: 1 } },
            });
          }
        }
        continue;
      }
      await prisma.gameOutbox.updateMany({
        where: { id: row.id, status: "DISPATCHED" },
        data: { status: "PENDING" },
      });
    }
  }
  return dispatchPendingOutbox(prisma, queues, redis);
}
