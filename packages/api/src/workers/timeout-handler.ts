import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ActionType } from "@pokertools/types";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { GameManager } from "../services/game-manager.js";
import { durableOutboxProcessor } from "../services/game-outbox.js";

/** Committed durable payload of a scheduled player-timeout intent. */
export interface PlayerTimeoutPayload {
  tableId: string;
  playerId: string;
  /** Semantic ownership epoch (new intents); absent on legacy intents. */
  handId?: unknown;
  anchorEventSeq?: unknown;
  /** Legacy strict version fence; also the anchor version of an owned lease. */
  expectedVersion: unknown;
}

/**
 * Execute one committed player-timeout payload through the authoritative
 * manager. The queue job data is never the authority: only the committed
 * PostgreSQL outbox payload is interpreted here.
 *
 * A well-formed semantic epoch (canonical hand id + anchor event seq + legacy
 * version fence) is passed to the manager's private ownership validation, which
 * runs inside the existing table lock + transaction. A payload without the
 * epoch falls back to the legacy strict version guard.
 */
export async function processPlayerTimeoutPayload(
  prisma: PrismaClient,
  manager: GameManager,
  payload: PlayerTimeoutPayload
): Promise<void> {
  const { tableId, playerId, handId, anchorEventSeq, expectedVersion } = payload;
  if (
    typeof tableId !== "string" ||
    typeof playerId !== "string" ||
    !Number.isSafeInteger(expectedVersion) ||
    (expectedVersion as number) < 0
  ) {
    throw new Error("Timeout requires a valid durable turn identity");
  }

  const table = await prisma.table.findUnique({
    where: { id: tableId },
    select: { status: true },
  });
  if (!table || table.status === "CLOSED") return;

  if (
    typeof handId === "string" &&
    handId.length > 0 &&
    Number.isSafeInteger(anchorEventSeq) &&
    (anchorEventSeq as number) >= 1
  ) {
    await manager.processAction(tableId, { type: ActionType.TIMEOUT, playerId }, playerId, {
      timeoutOwnership: {
        handId,
        anchorEventSeq: anchorEventSeq as number,
        expectedVersion: expectedVersion as number,
        playerId,
      },
    });
    return;
  }

  await manager.processAction(tableId, { type: ActionType.TIMEOUT, playerId }, playerId, {
    expectedVersion: expectedVersion as number,
  });
}

/** The production timeout consumer, shared by process wiring and acceptance. */
export function createPlayerTimeoutWorker(
  prisma: PrismaClient,
  manager: GameManager,
  redis: Redis
): Worker {
  return new Worker(
    "player-timeout",
    durableOutboxProcessor(prisma, "player-timeout", (payload) =>
      processPlayerTimeoutPayload(prisma, manager, payload as PlayerTimeoutPayload)
    ),
    { connection: redis }
  );
}
