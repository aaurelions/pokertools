import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ActionType } from "@pokertools/types";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { GameManager } from "../services/game-manager.js";
import { durableOutboxProcessor } from "../services/game-outbox.js";

/** The production timeout consumer, shared by process wiring and acceptance. */
export function createPlayerTimeoutWorker(
  prisma: PrismaClient,
  manager: GameManager,
  redis: Redis
): Worker {
  return new Worker(
    "player-timeout",
    durableOutboxProcessor(
      prisma,
      "player-timeout",
      async ({
        tableId,
        playerId,
        expectedVersion,
      }: {
        tableId: string;
        playerId: string;
        expectedVersion: number;
      }) => {
        if (
          typeof tableId !== "string" ||
          typeof playerId !== "string" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0
        ) {
          throw new Error("Timeout requires a valid durable turn identity");
        }
        const table = await prisma.table.findUnique({
          where: { id: tableId },
          select: { status: true },
        });
        if (!table || table.status === "CLOSED") return;
        await manager.processAction(tableId, { type: ActionType.TIMEOUT, playerId }, playerId, {
          expectedVersion,
        });
      }
    ),
    { connection: redis }
  );
}
