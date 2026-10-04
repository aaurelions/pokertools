import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { ActionType } from "@pokertools/types";
import { config } from "../config.js";
import { canonicalHandIdentity, type GameManager } from "../services/game-manager.js";
import { loadAuthoritativeTable } from "../services/game-repository.js";
import { durableOutboxProcessor } from "../services/game-outbox.js";

/**
 * Durable next-hand intent payload.
 *
 * `expectedHandId` is the table-scoped canonical identity of the hand whose
 * completion scheduled this job. For new intents it is the authority: the job
 * may only act on that exact hand, regardless of any benign version movement
 * within it. `expectedVersion` is retained for observability and remains the
 * strict guard for legacy intents written before the identity existed.
 */
export interface NextHandIntentPayload {
  tableId: string;
  expectedVersion: number;
  expectedHandId?: string;
}

/**
 * Execute a committed next-hand intent against the authoritative snapshot.
 *
 * The decision is read from PostgreSQL under the shared table lock; Redis is
 * never consulted for state. Identity replaces the version snapshot as the
 * hand-scoped guard:
 *
 * - A missing/CLOSED table is a no-op.
 * - A payload identity that does not match the authoritative hand is a no-op:
 *   a manual DEAL, a newer hand, or a duplicate/replayed job can never advance
 *   play twice.
 * - A matching identity only proceeds when the authoritative hand is a
 *   completed SHOWDOWN with winners; a benign same-hand version change (e.g. a
 *   late SHOW at showdown) must not strand the auto-deal, but an unsettled hand
 *   is never re-dealt.
 * - Legacy payloads without an identity keep the strict version guard and are
 *   never guessed at.
 *
 * The DEAL itself is submitted through the same DB-authoritative CAS as any
 * other mutation, evaluated against the version just read under the lock, so
 * a race with a manual DEAL still loses the CAS and cannot double-deal.
 */
export async function executeNextHandIntent(
  prisma: PrismaClient,
  manager: GameManager,
  redlock: Redlock,
  payload: NextHandIntentPayload
): Promise<void> {
  const { tableId, expectedVersion, expectedHandId } = payload;

  let lock;
  try {
    lock = await redlock.lock([`lock:table:${tableId}`], config.NEXT_HAND_LOCK_TTL_MS);
  } catch (err) {
    throw new Error(`Unable to acquire auto-deal lock for table ${tableId}`, { cause: err });
  }

  try {
    const record = await loadAuthoritativeTable(prisma, tableId);
    if (!record || !record.snapshot || record.status === "CLOSED") return;

    // Hand-scoped identity is the authority for new intents. A malformed
    // identity, or one that does not match the authoritative hand, is a no-op:
    // never guess which hand a job meant. Legacy intents (identity absent) keep
    // the strict expectedVersion guard.
    if (expectedHandId !== undefined) {
      if (typeof expectedHandId !== "string" || expectedHandId.length === 0) return;
      if (canonicalHandIdentity(tableId, record.snapshot.handId) !== expectedHandId) return;
    } else if (expectedVersion !== record.stateVersion) {
      return;
    }

    const snapshot = record.snapshot;
    // Only a completed hand with winners may advance.
    if (snapshot.street !== "SHOWDOWN" || !snapshot.winners) {
      return;
    }

    const activePlayers = snapshot.players.filter((p) => p !== null && p.stack > 0);
    if (activePlayers.length < 2) {
      await prisma.table.updateMany({
        where: { id: tableId, status: { not: "CLOSED" } },
        data: { status: "WAITING" },
      });
      return;
    }

    // CAS against the version just read under the lock; passing a stale payload
    // version would weaken the compare-and-set.
    await manager.processAction(tableId, { type: ActionType.DEAL }, "", {
      skipLock: true,
      expectedVersion: record.stateVersion,
    });

    console.log(`✅ Auto-dealt next hand for table ${tableId}`);
  } finally {
    await lock.unlock();
  }
}

/** The production next-hand consumer, shared by process wiring and acceptance. */
export function createNextHandWorker(
  prisma: PrismaClient,
  manager: GameManager,
  redis: Redis,
  redlock: Redlock
): Worker {
  return new Worker(
    "next-hand",
    durableOutboxProcessor(prisma, "next-hand", (payload: NextHandIntentPayload) =>
      executeNextHandIntent(prisma, manager, redlock, payload)
    ),
    { connection: redis }
  );
}
