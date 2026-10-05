import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { GameManager } from "../services/game-manager.js";
import { durableOutboxProcessor } from "../services/game-outbox.js";
import { reconcileTournament } from "../services/tournament-director.js";
import type { TournamentDirectorContext } from "../services/tournament-lifecycle.js";
import { AppError } from "../utils/errors.js";

/**
 * Durable tournament-director intent payload.
 *
 * Written in the same transaction as every tournament HAND_COMPLETED, whatever
 * produced it (canonical ACTION, worker DEAL, worker TIMEOUT). `actorId` is the
 * real public caller when there is one and null for background mutations; the
 * worker substitutes a namespaced system actor rather than forging a caller.
 */
export interface TournamentReconcileIntentPayload {
  tournamentId: string;
  tableId: string;
  /** Canonical hand identity (`<tableId>_<handId>`), the dedupe scope. */
  handId: string;
  actorId: string | null;
}

/**
 * Stable background actor for completions with no public caller. It is used
 * only as the management-mutation principal (skipIdentity) and the audit
 * `requestRef`; it is not a user id and never appears as an authenticated
 * caller.
 */
export const SYSTEM_TOURNAMENT_DIRECTOR_ACTOR = "system:tournament-director";

/**
 * Execute one committed tournament-reconcile intent through the authoritative
 * director. Idempotent: a repeated pass over the same accepted facts is a
 * no-op (the director's audit fingerprint is unique), so the inline route fast
 * path and this worker may both run.
 *
 * The outbox row is acknowledged (COMPLETED) only when the director pass
 * converged. A bounded iteration-cap deferral throws so BullMQ retries with
 * backoff and a restart recovers the obligation; a vanished tournament is a
 * terminal no-op.
 */
export async function executeTournamentReconcileIntent(
  context: TournamentDirectorContext,
  payload: TournamentReconcileIntentPayload
): Promise<void> {
  const { tournamentId, tableId, handId, actorId } = payload;
  if (
    typeof tournamentId !== "string" ||
    tournamentId.length === 0 ||
    typeof tableId !== "string" ||
    tableId.length === 0 ||
    typeof handId !== "string" ||
    handId.length === 0
  ) {
    throw new Error(
      "Tournament reconcile intent requires a durable tournament/table/hand identity"
    );
  }

  let result: { converged: boolean };
  try {
    result = await reconcileTournament(
      context,
      tournamentId,
      typeof actorId === "string" && actorId.length > 0 ? actorId : SYSTEM_TOURNAMENT_DIRECTOR_ACTOR
    );
  } catch (error) {
    // A deleted tournament (disposable fixtures, cancelled+purged data) has
    // nothing left to converge; anything else is a retryable failure.
    if (error instanceof AppError && error.statusCode === 404) return;
    throw error;
  }
  if (!result.converged) {
    throw new Error(
      `Tournament reconciliation deferred at the iteration cap for tournament ${tournamentId}`
    );
  }
}

/** The production tournament-reconcile consumer, shared by process wiring and acceptance. */
export function createTournamentReconcileWorker(
  prisma: PrismaClient,
  manager: GameManager,
  redis: Redis,
  redlock: Redlock,
  log: TournamentDirectorContext["log"]
): Worker {
  const context: TournamentDirectorContext = {
    prisma,
    gameManager: manager,
    redis,
    redlock,
    log,
  };
  return new Worker(
    "tournament-reconcile",
    durableOutboxProcessor(prisma, "tournament-reconcile", (payload) =>
      executeTournamentReconcileIntent(context, payload as TournamentReconcileIntentPayload)
    ),
    { connection: redis }
  );
}
