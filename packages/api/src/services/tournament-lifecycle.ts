import type { FastifyInstance } from "fastify";
import type { Action } from "@pokertools/engine";
import { ActionType } from "@pokertools/types";
import {
  computeTournamentPayouts,
  computeTournamentTableDistribution,
  validateBlindStructure,
  type BlindLevel,
} from "../utils/tournaments.js";
import { config } from "../config.js";
import { AppError } from "../utils/errors.js";
import { recordTournamentEvent } from "./tournament-events.js";

/**
 * Authoritative tournament lifecycle shared by the tournament routes and the
 * generic competition capability, so competitions reuse the exact seating,
 * dealing, settlement and audit machinery. The caller resolves the
 * authenticated actor; these functions own validation, the durable tournament
 * lock and rollback.
 */

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

/**
 * Authoritative start lifecycle. Validation, durable lock, authoritative
 * seating, first deal and rollback live here; route wrappers only translate
 * errors to HTTP.
 */
export async function startTournament(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<{ success: true; tableIds: string[]; distribution: number[] }> {
  const tournament = await fastify.prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: {
      entries: {
        include: { user: { select: { username: true } } },
        orderBy: { seat: "asc" },
      },
    },
  });
  if (!tournament) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
  if (tournament.status !== "REGISTRATION") {
    throw new AppError("Tournament has already started", 400, "TOURNAMENT_ALREADY_STARTED");
  }
  if (tournament.entries.length < 2) {
    throw new AppError(
      "Tournament requires at least two players",
      400,
      "TOURNAMENT_REQUIRES_TWO_PLAYERS"
    );
  }

  const registeredEntries = tournament.entries.filter((e) => e.status === "REGISTERED");
  const playerCount = registeredEntries.length;

  await requireTournamentManager(fastify, tournament.id, actorUserId);

  // Validate blind structure at start time (defense-in-depth)
  const blindStructure = (tournament.blindStructure as unknown as BlindLevel[]) ?? [];
  const primaryTable = await fastify.prisma.table.findUniqueOrThrow({
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
    distribution = computeTournamentTableDistribution(playerCount, tournament.tableMaxPlayers);
  } catch (error: unknown) {
    throw new AppError(errorMessage(error), 400);
  }

  const lock = await fastify.redlock.lock(
    [`lock:tournament:${tournament.id}`],
    config.TOURNAMENT_LOCK_TTL_MS
  );
  const tableIds: string[] = [tournament.tableId];
  const createdTableIds: string[] = [];
  const seatedPlayers: Array<{ tableId: string; userId: string }> = [];

  try {
    // Mark tournament as RUNNING
    const now = new Date();
    await fastify.prisma.tournament.update({
      where: { id: tournament.id },
      data: { status: "RUNNING", startedAt: now, lastBlindAdvancedAt: now },
    });
    await fastify.prisma.tournamentEntry.updateMany({
      where: { tournamentId: tournament.id, status: "REGISTERED" },
      data: { status: "ACTIVE" },
    });

    // Activate primary table
    await fastify.prisma.table.update({
      where: { id: tournament.tableId },
      data: { status: "ACTIVE" },
    });

    // Create additional tables and sit players
    const engineMax = Math.min(tournament.tableMaxPlayers, 10);

    let entryIndex = 0;

    for (let tableIdx = 0; tableIdx < distribution.length; tableIdx++) {
      const playersForTable = distribution[tableIdx];
      let tableId: string;
      if (tableIdx === 0) {
        tableId = tournament.tableId;
      } else {
        const blindLevel =
          blindStructure.length > 0
            ? blindStructure[0]
            : {
                smallBlind: primaryConfig.smallBlind,
                bigBlind: primaryConfig.bigBlind,
                ante: 0,
              };

        tableId = await fastify.gameManager.createTable({
          name: `${tournament.name} - Table ${tableIdx + 1}`,
          mode: "TOURNAMENT",
          smallBlind: blindLevel.smallBlind,
          bigBlind: blindLevel.bigBlind,
          maxPlayers: engineMax,
          blindStructure,
          startingStack: tournament.startingStack,
        });
        createdTableIds.push(tableId);
        await fastify.prisma.table.update({
          where: { id: tableId },
          data: { tournamentId: tournament.id, status: "ACTIVE" },
        });
        tableIds.push(tableId);
      }

      for (let i = 0; i < playersForTable; i++) {
        const entry = registeredEntries[entryIndex];
        const seatIdx = i;

        await fastify.gameManager.processAction(
          tableId,
          {
            type: ActionType.SIT,
            playerId: entry.userId,
            playerName: entry.user.username,
            seat: seatIdx,
            stack: tournament.startingStack,
          },
          actorUserId,
          { skipIdentity: true }
        );
        seatedPlayers.push({ tableId, userId: entry.userId });

        await fastify.prisma.tournamentEntry.update({
          where: { id: entry.id },
          data: { currentTableId: tableId, currentSeat: seatIdx },
        });

        entryIndex++;
      }
    }

    // Deal first hand on each table that has enough players
    for (const tableId of tableIds) {
      const state = await fastify.gameManager.getState(tableId);
      const playerCount = state.players.filter((p: unknown) => p !== null).length;
      if (playerCount >= 2) {
        await fastify.gameManager.processAction(tableId, { type: "DEAL" } as Action, actorUserId);
      }
    }

    // Durable audit of the accepted start facts. This is wrapped so an audit
    // write failure cannot roll back an already-seated/dealt tournament.
    try {
      await recordTournamentEvent(fastify.prisma, {
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
    } catch (error) {
      fastify.log.warn(
        { tournamentId: tournament.id, error },
        "Failed to record tournament start audit event"
      );
    }

    return { success: true, tableIds, distribution };
  } catch (error) {
    for (const seated of seatedPlayers.reverse()) {
      await fastify.gameManager
        .processAction(
          seated.tableId,
          { type: ActionType.STAND, playerId: seated.userId },
          actorUserId,
          { skipIdentity: true }
        )
        .catch((rollbackError: unknown) => {
          fastify.log.error(
            { tournamentId: tournament.id, seated, error: rollbackError },
            "CRITICAL: failed to rollback tournament start seat"
          );
        });
    }
    await Promise.all(
      createdTableIds.map(async (tableId) => {
        await fastify.prisma.table.delete({ where: { id: tableId } }).catch(() => undefined);
        await fastify.redis.del(`table:${tableId}`).catch(() => undefined);
      })
    );
    await fastify.prisma.tournament.update({
      where: { id: tournament.id },
      data: { status: "REGISTRATION", startedAt: null },
    });
    await fastify.prisma.tournamentEntry.updateMany({
      where: { tournamentId: tournament.id, status: "ACTIVE" },
      data: { status: "REGISTERED", currentTableId: null, currentSeat: null },
    });
    throw error;
  } finally {
    await lock.unlock();
  }
}

/**
 * Authoritative settlement lifecycle. Idempotent: an already FINISHED tournament
 * returns its accepted result without re-paying.
 */
export async function settleTournament(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<{
  success: true;
  winnerUserId: string | null;
  prize: number;
  payouts: Array<{ userId: string; placement: number; amount: number }>;
}> {
  // Quick pre-check outside lock for early exit
  const preCheck = await fastify.prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { status: true },
  });
  if (!preCheck) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");

  // Return idempotent settlement details if already FINISHED. The winner is
  // derived from the authoritative placement, independent of prize amounts
  // (a zero-prize competition tournament has no `prize > 0` rows).
  if (preCheck.status === "FINISHED") {
    const finishedTournament = await fastify.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        entries: {
          include: { user: { select: { username: true } } },
          orderBy: { placement: "asc" },
        },
      },
    });
    if (finishedTournament) {
      const winnerEntry = finishedTournament.entries.find((e) => e.placement === 1);
      const paidEntries = finishedTournament.entries.filter((e) => e.prize > 0);
      return {
        success: true,
        winnerUserId: winnerEntry?.userId ?? null,
        prize: winnerEntry?.prize ?? 0,
        payouts: paidEntries.map((e) => ({
          userId: e.userId,
          placement: e.placement ?? 0,
          amount: e.prize,
        })),
      };
    }
  }

  if (preCheck.status !== "RUNNING") {
    throw new AppError("Tournament is not running", 400, "TOURNAMENT_NOT_RUNNING");
  }

  await requireTournamentManager(fastify, tournamentId, actorUserId);

  // Acquire tournament lock before reading state and executing settlement
  const lock = await fastify.redlock.lock(
    [`lock:tournament:${tournamentId}`],
    config.TOURNAMENT_LOCK_TTL_MS
  );
  try {
    // Re-fetch full tournament state under lock
    const tournament = await fastify.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { entries: true, tables: { where: { status: { not: "CLOSED" } } } },
    });
    if (!tournament) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");

    // Double-check under lock: if another request settled this already, return
    // the idempotent result with the winner derived from placement 1 (never
    // from prize amounts).
    if (tournament.status === "FINISHED") {
      const finishedEntries = await fastify.prisma.tournamentEntry.findMany({
        where: { tournamentId },
        include: { user: { select: { username: true } } },
        orderBy: { placement: "asc" },
      });
      const winnerEntry = finishedEntries.find((e) => e.placement === 1);
      const paidEntries = finishedEntries.filter((e) => e.prize > 0);
      return {
        success: true,
        winnerUserId: winnerEntry?.userId ?? null,
        prize: winnerEntry?.prize ?? 0,
        payouts: paidEntries.map((e) => ({
          userId: e.userId,
          placement: e.placement ?? 0,
          amount: e.prize,
        })),
      };
    }

    // Collect stacks from all active tournament tables
    const stacks = new Map<string, number>();
    for (const table of tournament.tables) {
      try {
        const state = await fastify.gameManager.getState(table.id);
        if (!state) throw new Error(`Table ${table.id} state not found`);
        const players = state.players;
        for (const p of players) {
          if (p) {
            stacks.set(p.id, (stacks.get(p.id) ?? 0) + p.stack);
          }
        }
      } catch (error) {
        throw Object.assign(new Error(`Unable to read tournament table state for ${table.id}`), {
          statusCode: 503,
          code: "TOURNAMENT_STATE_UNAVAILABLE",
          cause: error,
        });
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
        return entry && amount > 0 ? { entry, placement, amount } : null;
      })
      .filter(
        (
          payout
        ): payout is {
          entry: (typeof tournament.entries)[number];
          placement: number;
          amount: number;
        } => payout !== null
      );

    const closedTableIds = tournament.tables.map((table) => table.id);

    await fastify.prisma.$transaction(async (tx) => {
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
          prize: payouts.find((payout) => payout.entry.id === winner.id)?.amount ?? 0,
        },
      });

      for (const entry of tournament.entries.filter((e) => e.id !== winner.id)) {
        const placement = placementByEntryId.get(entry.id);
        if (placement === undefined) {
          throw new Error(`Missing tournament placement for entry ${entry.id}`);
        }
        const prize = payouts.find((payout) => payout.entry.id === entry.id)?.amount ?? 0;
        await tx.tournamentEntry.update({
          where: { id: entry.id },
          data: {
            status: prize > 0 ? "PAID" : "ELIMINATED",
            placement,
            prize,
          },
        });
      }

      await tx.tournament.update({
        where: { id: tournament.id },
        data: { status: "FINISHED", finishedAt: new Date() },
      });

      // Close all tournament tables
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
          prizePool: tournament.prizePool,
          payoutPercentages,
          payouts: payouts.map((payout) => ({
            userId: payout.entry.userId,
            entryId: payout.entry.id,
            placement: payout.placement,
            amount: payout.amount,
          })),
          closedTableIds,
        },
        stateFingerprint: `settled:${tournament.id}`,
        requestRef: actorUserId,
      });
    });

    await fastify.auditManager.record({
      actorId: actorUserId,
      action: "TOURNAMENT_SETTLE",
      resource: `tournament:${tournament.id}`,
      metadata: {
        winnerUserId: winner.userId,
        payouts: payouts.map((payout) => ({
          userId: payout.entry.userId,
          placement: payout.placement,
          amount: payout.amount,
        })),
      },
    });

    return {
      success: true,
      winnerUserId: winner.userId,
      prize: payouts.find((payout) => payout.entry.id === winner.id)?.amount ?? 0,
      payouts: payouts.map((payout) => ({
        userId: payout.entry.userId,
        placement: payout.placement,
        amount: payout.amount,
      })),
    };
  } finally {
    await lock.unlock();
  }
}
