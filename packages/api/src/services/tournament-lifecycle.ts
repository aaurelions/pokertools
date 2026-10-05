import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import { ActionType } from "@pokertools/types";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { GameManager } from "./game-manager.js";
import {
  computeTournamentPayouts,
  computeTournamentTableDistribution,
  toSafeChipNumber,
  validateBlindStructure,
  type BlindLevel,
} from "../utils/tournaments.js";
import { config } from "../config.js";
import { AppError } from "../utils/errors.js";
import { loadAuthoritativeTable } from "./game-repository.js";
import { recordTournamentEvent } from "./tournament-events.js";

/**
 * Authoritative tournament lifecycle shared by the tournament routes and the
 * generic competition capability, so competitions reuse the exact seating,
 * dealing, settlement and audit machinery. The caller resolves the
 * authenticated actor; these functions own validation, the durable tournament
 * lock and rollback.
 *
 * PostgreSQL is the sole authority for every lifecycle transition: each of
 * start / settle / reconcile runs one serialized transaction on the tournament
 * row (plus sorted table row locks for multi-table decisions), re-reads status,
 * entries and authoritative `Table.state` snapshots through that transaction,
 * and applies engine mutations through `GameManager.applyManagementMutationInTx`
 * so the existing DB stateVersion/eventSeq CAS, seat occupancy, ordered events
 * and transactional outbox all commit together. Redis (Redlock) is only a
 * best-effort contention optimization and is never required for correctness.
 */

/**
 * Minimal platform context the tournament director needs. The Fastify app
 * satisfies it structurally, and durable background workers construct it
 * directly from their own Prisma/Redis/Redlock/GameManager instances.
 */
export interface TournamentDirectorContext {
  prisma: PrismaClient;
  gameManager: GameManager;
  redis: Pick<Redis, "status">;
  redlock: Redlock;
  log: { warn: (obj: unknown, msg?: string) => void };
}

export async function requireTournamentManager(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<void> {
  const [tournament, actor] = await Promise.all([
    fastify.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { creatorId: true },
    }),
    fastify.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { role: true },
    }),
  ]);
  if (!tournament) {
    throw Object.assign(new Error("Tournament not found"), {
      statusCode: 404,
      code: "TOURNAMENT_NOT_FOUND",
    });
  }
  if (tournament.creatorId !== actorUserId && actor?.role !== "ADMIN") {
    throw Object.assign(new Error("Tournament management requires the creator or an admin"), {
      statusCode: 403,
      code: "TOURNAMENT_FORBIDDEN",
    });
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Invalid tournament configuration";

function isPostgresDatabase(): boolean {
  return (config.DATABASE_URL ?? "").startsWith("postgres");
}

/**
 * Serialize lifecycle transitions for one tournament on its durable row.
 * PostgreSQL takes an explicit row lock; SQLite serializes writers at the
 * database level. Every caller MUST re-read and re-check state after this.
 */
export async function lockTournamentRow(
  tx: Prisma.TransactionClient,
  tournamentId: string
): Promise<void> {
  if (isPostgresDatabase()) {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Tournament" WHERE "id" = $1 FOR UPDATE',
      tournamentId
    );
  }
}

/**
 * Lock the authoritative table rows a multi-table decision will read and
 * mutate, in a deterministic sorted order so concurrent director/start/settle
 * transactions cannot deadlock. No other writer can commit a `Table.state`
 * change between our snapshot read and the CAS inside the same transaction.
 */
export async function lockTableRows(
  tx: Prisma.TransactionClient,
  tableIds: readonly string[]
): Promise<void> {
  if (!isPostgresDatabase() || tableIds.length === 0) return;
  const sorted = [...new Set(tableIds)].sort();
  const placeholders = sorted.map((_, index) => `$${index + 1}`).join(", ");
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "Table" WHERE "id" IN (${placeholders}) ORDER BY "id" FOR UPDATE`,
    ...sorted
  );
}

/**
 * Best-effort Redlock contention optimization. Never required for
 * correctness: when Redis is unavailable the DB row lock alone serializes the
 * transition, and the lock is released by TTL if the unlock fails.
 */
export async function acquireTournamentLockBestEffort(
  context: TournamentDirectorContext,
  tournamentId: string
): Promise<{ unlock: () => Promise<void> } | null> {
  if (context.redis.status !== "ready") return null;
  try {
    return await context.redlock.lock(
      [`lock:tournament:${tournamentId}`],
      config.TOURNAMENT_LOCK_TTL_MS
    );
  } catch {
    return null;
  }
}

/**
 * Acceptance-test crash seam: invoked exactly after the authoritative
 * settlement transaction commits and before the caller's prize disposition.
 * Production never sets it; the acceptance suite uses it to exercise the real
 * crash window instead of reaching around the lifecycle with a fabricated
 * winner or a public legacy route.
 */
let settlementCommitFaultInjector: (() => void) | null = null;

export function setSettlementCommitFaultInjector(injector: (() => void) | null): void {
  settlementCommitFaultInjector = injector;
}

interface SettlementResult {
  success: true;
  winnerUserId: string | null;
  prize: number;
  payouts: Array<{ userId: string; placement: number; amount: number }>;
}

interface SettlementEntry {
  id: string;
  userId: string;
  status: string;
  placement: number | null;
  prize: bigint;
}

function buildSettlementResult(entries: readonly SettlementEntry[]): SettlementResult {
  const ordered = [...entries].sort(
    (a, b) => (a.placement ?? Number.MAX_SAFE_INTEGER) - (b.placement ?? Number.MAX_SAFE_INTEGER)
  );
  const winnerEntry = ordered.find((entry) => entry.placement === 1);
  const paidEntries = ordered.filter((entry) => entry.prize > 0n);
  return {
    success: true,
    winnerUserId: winnerEntry?.userId ?? null,
    prize: toSafeChipNumber(winnerEntry?.prize ?? 0n),
    payouts: paidEntries.map((entry) => ({
      userId: entry.userId,
      placement: entry.placement ?? 0,
      amount: toSafeChipNumber(entry.prize),
    })),
  };
}

/**
 * Authoritative start lifecycle. Validation, durable lock, authoritative
 * seating, first deal and rollback live here; route wrappers only translate
 * errors to HTTP.
 *
 * The whole start — additional table provisioning, every SIT, entry
 * assignment, the first DEAL and the RUNNING transition — commits in one
 * database transaction on the tournament row. A failure at any point rolls the
 * entire start back, so there is no orphan table, no partially seated
 * tournament and no half-restarted state to compensate.
 */
export async function startTournament(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<{ success: true; tableIds: string[]; distribution: number[] }> {
  // Fast, non-authoritative pre-check for early rejection.
  const precheck = await fastify.prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { status: true, entries: { select: { id: true } } },
  });
  if (!precheck) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
  if (precheck.status !== "REGISTRATION") {
    throw new AppError("Tournament has already started", 400, "TOURNAMENT_ALREADY_STARTED");
  }
  if (precheck.entries.length < 2) {
    throw new AppError(
      "Tournament requires at least two players",
      400,
      "TOURNAMENT_REQUIRES_TWO_PLAYERS"
    );
  }

  await requireTournamentManager(fastify, tournamentId, actorUserId);

  const lock = await acquireTournamentLockBestEffort(fastify, tournamentId);
  try {
    const result = await fastify.prisma.$transaction(
      async (tx) => {
        await lockTournamentRow(tx, tournamentId);

        const tournament = await tx.tournament.findUnique({
          where: { id: tournamentId },
          include: {
            entries: {
              include: { user: { select: { username: true } } },
              orderBy: { seat: "asc" },
            },
          },
        });
        if (!tournament) {
          throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }
        if (tournament.status !== "REGISTRATION") {
          throw new AppError("Tournament has already started", 400, "TOURNAMENT_ALREADY_STARTED");
        }

        const registeredEntries = tournament.entries.filter(
          (entry) => entry.status === "REGISTERED"
        );
        if (registeredEntries.length < 2) {
          throw new AppError(
            "Tournament requires at least two players",
            400,
            "TOURNAMENT_REQUIRES_TWO_PLAYERS"
          );
        }
        const playerCount = registeredEntries.length;

        const blindStructure = (tournament.blindStructure as unknown as BlindLevel[]) ?? [];
        const primaryTable = await tx.table.findUniqueOrThrow({
          where: { id: tournament.tableId },
          select: { config: true },
        });
        const primaryConfig = primaryTable.config as { smallBlind: number; bigBlind: number };
        try {
          validateBlindStructure(blindStructure);
        } catch (error: unknown) {
          throw new AppError(errorMessage(error), 400);
        }

        let distribution: number[];
        try {
          distribution = computeTournamentTableDistribution(
            playerCount,
            tournament.tableMaxPlayers
          );
        } catch (error: unknown) {
          throw new AppError(errorMessage(error), 400);
        }

        // Sorted table row locks: no concurrent engine mutation can commit
        // between the seating snapshots we CAS against and this commit.
        const existingTables = await tx.table.findMany({
          where: { tournamentId },
          select: { id: true },
        });
        await lockTableRows(tx, [tournament.tableId, ...existingTables.map((row) => row.id)]);

        const engineMax = Math.min(tournament.tableMaxPlayers, 10);
        const tableIds: string[] = [tournament.tableId];
        const now = new Date();

        for (let tableIdx = 1; tableIdx < distribution.length; tableIdx++) {
          const blindLevel =
            blindStructure.length > 0
              ? blindStructure[0]
              : {
                  smallBlind: primaryConfig.smallBlind,
                  bigBlind: primaryConfig.bigBlind,
                  ante: 0,
                };
          const { tableId } = await fastify.gameManager.createTableInTx(tx, {
            name: `${tournament.name} - Table ${tableIdx + 1}`,
            mode: "TOURNAMENT",
            smallBlind: blindLevel.smallBlind,
            bigBlind: blindLevel.bigBlind,
            maxPlayers: engineMax,
            blindStructure,
            startingStack: tournament.startingStack,
          });
          await tx.table.update({
            where: { id: tableId },
            data: { tournamentId: tournament.id, status: "ACTIVE" },
          });
          tableIds.push(tableId);
        }

        // Mark the tournament RUNNING and the primary table active inside the
        // same transaction that seats and deals; nothing is observable until
        // every seat and the first hand are durable.
        await tx.tournament.update({
          where: { id: tournament.id },
          data: { status: "RUNNING", startedAt: now, lastBlindAdvancedAt: now },
        });
        await tx.tournamentEntry.updateMany({
          where: { tournamentId: tournament.id, status: "REGISTERED" },
          data: { status: "ACTIVE" },
        });
        await tx.table.update({
          where: { id: tournament.tableId },
          data: { status: "ACTIVE" },
        });

        let entryIndex = 0;
        for (let tableIdx = 0; tableIdx < distribution.length; tableIdx++) {
          const tableId = tableIds[tableIdx];
          for (let seatIdx = 0; seatIdx < distribution[tableIdx]; seatIdx++) {
            const entry = registeredEntries[entryIndex];
            await fastify.gameManager.applyManagementMutationInTx(
              tx,
              tableId,
              actorUserId,
              {
                type: ActionType.SIT,
                playerId: entry.userId,
                playerName: entry.user.username,
                seat: seatIdx,
                stack: tournament.startingStack,
              },
              { skipIdentity: true }
            );
            await tx.tournamentEntry.update({
              where: { id: entry.id },
              data: { currentTableId: tableId, currentSeat: seatIdx },
            });
            entryIndex++;
          }
        }

        // Deal the first hand on every table with enough players, still inside
        // the same commit as the seating.
        for (let tableIdx = 0; tableIdx < distribution.length; tableIdx++) {
          if (distribution[tableIdx] < 2) continue;
          await fastify.gameManager.applyManagementMutationInTx(
            tx,
            tableIds[tableIdx],
            actorUserId,
            { type: ActionType.DEAL },
            { skipIdentity: true }
          );
        }

        await recordTournamentEvent(tx, {
          tournamentId: tournament.id,
          type: "TOURNAMENT_STARTED",
          payload: {
            tableIds,
            distribution,
            players: registeredEntries.length,
          },
          stateFingerprint: `started:${distribution.join(",")}:${registeredEntries.length}`,
          requestRef: actorUserId,
        });

        return { success: true as const, tableIds, distribution };
      },
      { maxWait: 10_000, timeout: 20_000 }
    );

    // Post-commit cache/outbox dispatch is best-effort; the database is
    // authoritative and recovery re-drives any undispatched outbox intent.
    for (const tableId of result.tableIds) {
      await fastify.gameManager.publishCommitted(tableId).catch(() => undefined);
    }

    return result;
  } finally {
    if (lock) await lock.unlock().catch(() => undefined);
  }
}

/**
 * Authoritative settlement lifecycle. Idempotent: an already FINISHED
 * tournament returns its accepted result without re-paying. Authorization is
 * enforced before the FINISHED replay, so settlement details are never exposed
 * to a non-manager.
 *
 * The whole settlement — payouts, placements, FINISHED transition, table
 * closures and the settlement audit — runs in one serialized transaction on
 * the tournament row, reading fresh placements and authoritative table
 * snapshots through that transaction. Payout journals keep their existing
 * natural idempotency ids, so a replay can never double-pay.
 */
export async function settleTournament(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<SettlementResult> {
  const exists = await fastify.prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true },
  });
  if (!exists) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");

  // Authorization first: a FINISHED replay must never expose settlement
  // details (winner, payouts) to a non-manager.
  await requireTournamentManager(fastify, tournamentId, actorUserId);

  const lock = await acquireTournamentLockBestEffort(fastify, tournamentId);
  let result: SettlementResult;
  try {
    result = await fastify.prisma.$transaction(
      async (tx) => {
        await lockTournamentRow(tx, tournamentId);

        const tournament = await tx.tournament.findUnique({
          where: { id: tournamentId },
          include: { entries: true, tables: true },
        });
        if (!tournament) {
          throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }

        // Double-check under the durable lock: if another request settled this
        // already, replay the accepted result derived from placement 1 (never
        // from prize amounts).
        if (tournament.status === "FINISHED") {
          return buildSettlementResult(tournament.entries);
        }
        if (tournament.status !== "RUNNING") {
          throw new AppError("Tournament is not running", 400, "TOURNAMENT_NOT_RUNNING");
        }

        await lockTableRows(
          tx,
          tournament.tables.map((table) => table.id)
        );

        // Authoritative stacks: read the durable `Table.state` snapshot through
        // the same transaction that holds the table row locks. Redis is never
        // consulted for correctness.
        const stacks = new Map<string, number>();
        for (const table of tournament.tables) {
          const record = await loadAuthoritativeTable(tx, table.id);
          if (!record || !record.snapshot) {
            throw Object.assign(
              new Error(`Unable to read tournament table state for ${table.id}`),
              {
                statusCode: 503,
                code: "TOURNAMENT_STATE_UNAVAILABLE",
              }
            );
          }
          for (const player of record.snapshot.players) {
            if (player) stacks.set(player.id, (stacks.get(player.id) ?? 0) + player.stack);
          }
        }

        const activeEntries = tournament.entries.filter(
          (entry) => entry.status === "ACTIVE" && (stacks.get(entry.userId) ?? 0) > 0
        );

        if (activeEntries.length !== 1) {
          throw Object.assign(new Error("Tournament is not complete"), {
            statusCode: 400,
            code: "TOURNAMENT_NOT_COMPLETE",
            activePlayers: activeEntries.length,
          });
        }

        const winner = activeEntries[0];
        const payoutPercentages = tournament.payoutPercentages as unknown as number[];
        const payoutAmounts = computeTournamentPayouts(tournament.prizePool, payoutPercentages);
        const entriesByPlacement = new Map<number, (typeof tournament.entries)[number]>();
        const placementByEntryId = new Map<string, number>();
        entriesByPlacement.set(1, winner);
        placementByEntryId.set(winner.id, 1);

        for (const entry of tournament.entries) {
          if (entry.id !== winner.id && entry.placement != null) {
            entriesByPlacement.set(entry.placement, entry);
            placementByEntryId.set(entry.id, entry.placement);
          }
        }

        const unplacedEntries = tournament.entries.filter(
          (entry) => entry.id !== winner.id && entry.placement == null
        );
        const usedPlacements = new Set(entriesByPlacement.keys());
        for (const entry of unplacedEntries) {
          let placement = 2;
          while (usedPlacements.has(placement)) placement++;
          usedPlacements.add(placement);
          entriesByPlacement.set(placement, entry);
          placementByEntryId.set(entry.id, placement);
        }

        const payouts = payoutAmounts
          .map((amount, index) => {
            const placement = index + 1;
            const entry = entriesByPlacement.get(placement);
            return entry && amount > 0n ? { entry, placement, amount } : null;
          })
          .filter(
            (
              payout
            ): payout is {
              entry: (typeof tournament.entries)[number];
              placement: number;
              amount: bigint;
            } => payout !== null
          );

        const closedTableIds = tournament.tables.map((table) => table.id);

        for (const payout of payouts) {
          await fastify.financialManager.payoutTournament(
            tx,
            payout.entry.userId,
            tournament.id,
            payout.amount,
            { idempotencyKey: `tournament-settle:${tournament.id}:${payout.entry.id}` }
          );
        }

        await tx.tournamentEntry.update({
          where: { id: winner.id },
          data: {
            status: payouts.some((payout) => payout.entry.id === winner.id) ? "PAID" : "ELIMINATED",
            placement: 1,
            prize: payouts.find((payout) => payout.entry.id === winner.id)?.amount ?? 0n,
          },
        });

        for (const entry of tournament.entries.filter((candidate) => candidate.id !== winner.id)) {
          const placement = placementByEntryId.get(entry.id);
          if (placement === undefined) {
            throw new Error(`Missing tournament placement for entry ${entry.id}`);
          }
          const prize = payouts.find((payout) => payout.entry.id === entry.id)?.amount ?? 0n;
          await tx.tournamentEntry.update({
            where: { id: entry.id },
            data: {
              status: prize > 0n ? "PAID" : "ELIMINATED",
              placement,
              prize,
            },
          });
        }

        await tx.tournament.update({
          where: { id: tournament.id },
          data: { status: "FINISHED", finishedAt: new Date() },
        });

        // Close all tournament tables.
        await tx.table.updateMany({
          where: { tournamentId: tournament.id },
          data: { status: "CLOSED" },
        });

        // Durable append-only settlement audit inside the same transaction as
        // the accepted payouts and status change. The stable fingerprint makes
        // a repeated settle a no-op (it never duplicates the economic payout).
        await recordTournamentEvent(tx, {
          tournamentId: tournament.id,
          type: "TOURNAMENT_SETTLED",
          payload: {
            winnerUserId: winner.userId,
            prizePool: toSafeChipNumber(tournament.prizePool),
            payoutPercentages,
            payouts: payouts.map((payout) => ({
              userId: payout.entry.userId,
              entryId: payout.entry.id,
              placement: payout.placement,
              amount: toSafeChipNumber(payout.amount),
            })),
            closedTableIds,
          },
          stateFingerprint: `settled:${tournament.id}`,
          requestRef: actorUserId,
        });

        return {
          success: true as const,
          winnerUserId: winner.userId,
          prize: toSafeChipNumber(
            payouts.find((payout) => payout.entry.id === winner.id)?.amount ?? 0n
          ),
          payouts: payouts.map((payout) => ({
            userId: payout.entry.userId,
            placement: payout.placement,
            amount: toSafeChipNumber(payout.amount),
          })),
        };
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
  } finally {
    if (lock) await lock.unlock().catch(() => undefined);
  }

  // Simulated crash window: the tournament settlement is durably committed,
  // but the caller has not yet disposed any competition prize.
  settlementCommitFaultInjector?.();

  // Best-effort audit: a committed settlement is never reported as failed
  // because observability persistence was unavailable.
  try {
    await fastify.auditManager.record({
      actorId: actorUserId,
      action: "TOURNAMENT_SETTLE",
      resource: `tournament:${tournamentId}`,
      metadata: {
        winnerUserId: result.winnerUserId,
        payouts: result.payouts,
      },
    });
  } catch {
    // Audit is observability, not the commit.
  }

  return result;
}
