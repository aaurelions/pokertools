import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Action } from "@pokertools/engine";
import {
  ActionType,
  CreateTournamentSchema,
  RegisterTournamentRequestSchema,
  type CreateTournamentRequest,
  type RegisterTournamentRequest,
} from "@pokertools/types";
import {
  defaultBlindStructure,
  validateBlindStructure,
  MAX_RECONCILE_ITERATIONS,
  type BlindLevel,
} from "../../utils/tournaments.js";
import { config } from "../../config.js";
import { getHouseUserId } from "../../utils/house-user.js";
import { InsufficientFundsError } from "../../utils/errors.js";
import {
  requireTournamentManager,
  settleTournament,
  startTournament,
} from "../../services/tournament-lifecycle.js";
import {
  recordTournamentEvent,
  tournamentStateFingerprint,
} from "../../services/tournament-events.js";

type TournamentStatus = "REGISTRATION" | "RUNNING" | "FINISHED" | "CANCELLED";

interface TournamentTableInfo {
  id: string;
  status: string;
  playerCount: number;
}

interface TournamentListItem {
  id: string;
  name: string;
  status: TournamentStatus;
  tableId: string;
  buyIn: number;
  fee: number;
  startingStack: number;
  maxPlayers: number;
  tableMaxPlayers: number;
  balancingTolerance: number;
  registeredPlayers: number;
  prizePool: number;
  startsAt?: string | null;
}

interface TournamentDetails extends TournamentListItem {
  blindStructure: BlindLevel[];
  payoutPercentages: number[];
  tables: TournamentTableInfo[];
  entries: Array<{
    id: string;
    userId?: string;
    username?: string;
    seat: number;
    status: "REGISTERED" | "ACTIVE" | "ELIMINATED" | "PAID";
    placement?: number | null;
    prize: number;
    currentTableId?: string | null;
    currentSeat?: number | null;
  }>;
  startedAt?: string | null;
  finishedAt?: string | null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Invalid tournament configuration";

const toTournamentListItem = (tournament: {
  id: string;
  name: string;
  status: "REGISTRATION" | "RUNNING" | "FINISHED" | "CANCELLED";
  tableId: string;
  buyIn: number;
  fee: number;
  startingStack: number;
  maxPlayers: number;
  tableMaxPlayers: number;
  balancingTolerance: number;
  prizePool: number;
  startsAt: Date | null;
  entries: unknown[];
}): TournamentListItem => ({
  id: tournament.id,
  name: tournament.name,
  status: tournament.status,
  tableId: tournament.tableId,
  buyIn: tournament.buyIn,
  fee: tournament.fee,
  startingStack: tournament.startingStack,
  maxPlayers: tournament.maxPlayers,
  tableMaxPlayers: tournament.tableMaxPlayers,
  balancingTolerance: tournament.balancingTolerance,
  registeredPlayers: tournament.entries.length,
  prizePool: tournament.prizePool,
  startsAt: tournament.startsAt?.toISOString() ?? null,
});

/**
 * Tournament director reconciliation.
 *
 * Detects live stacks across all tournament tables, updates eliminated
 * entries with placements, rebalances tables, breaks short tables,
 * and merges to final table when remaining players fit on one table.
 *
 * Prefers moves only between completed hands (winners != null, actionTo == null).
 * Uses bounded iterations (MAX_RECONCILE_ITERATIONS) to prevent infinite loops.
 * STAND/SIT moves are rollback-safe: if SIT fails, the player is re-SIT-ed
 * to their original seat so no player is ever lost during reconciliation.
 */
export async function reconcileTournament(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
): Promise<void> {
  const lock = await fastify.redlock.lock(
    [`lock:tournament:${tournamentId}`],
    config.TOURNAMENT_LOCK_TTL_MS
  );
  let tableLock;
  try {
    const tables = await fastify.prisma.table.findMany({
      where: { tournamentId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    // Freeze the observed hand boundaries while reconciling. A source hand
    // completion must not race an automatic deal or a destination player action.
    if (tables.length) {
      tableLock = await fastify.redlock.lock(
        tables.map((table) => `lock:table:${table.id}`),
        config.TOURNAMENT_LOCK_TTL_MS
      );
    }
    await reconcileTournamentState(fastify, tournamentId, actorUserId, MAX_RECONCILE_ITERATIONS);
    // Durable append-only audit of the accepted reconciliation state. Repeated
    // reconciles that accept the same state produce the same stable fingerprint
    // and append no spurious event. Audit failure never rolls back accepted
    // director work (seats/stacks are already committed).
    try {
      const after = await fastify.prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: {
          status: true,
          entries: {
            select: {
              id: true,
              status: true,
              placement: true,
              currentTableId: true,
              currentSeat: true,
            },
          },
          tables: { select: { id: true, status: true } },
        },
      });
      if (after && after.status === "RUNNING") {
        const stateFingerprint = tournamentStateFingerprint(after);
        await recordTournamentEvent(fastify.prisma, {
          tournamentId,
          type: "TOURNAMENT_RECONCILED",
          payload: {
            status: after.status,
            tables: after.tables,
            entries: after.entries,
          },
          stateFingerprint,
          requestRef: actorUserId,
        });
      }
    } catch (error) {
      fastify.log.warn(
        { tournamentId, error },
        "Failed to record tournament reconcile audit event"
      );
    }
  } finally {
    try {
      await tableLock?.unlock();
    } finally {
      await lock.unlock();
    }
  }
}

/**
 * Safely move a player from one table to another with rollback on failure.
 * Ensures no player is ever lost: if SIT on the destination fails after a
 * successful STAND, the player is re-SIT-ed to their original seat.
 */
async function safeMovePlayer(
  fastify: FastifyInstance,
  player: {
    userId: string;
    username: string;
    stack: number;
    tableId: string;
    seat: number;
    entryId: string;
  },
  destTableId: string,
  destSeat: number,
  actorUserId: string
): Promise<void> {
  const origTableId = player.tableId;
  const origSeat = player.seat;
  let stood = false;
  let seatedAtDestination = false;

  try {
    await fastify.gameManager.processAction(
      origTableId,
      { type: ActionType.STAND, playerId: player.userId },
      actorUserId,
      { skipIdentity: true, skipLock: true }
    );
    stood = true;

    await fastify.gameManager.processAction(
      destTableId,
      {
        type: ActionType.SIT,
        playerId: player.userId,
        playerName: player.username,
        seat: destSeat,
        stack: player.stack,
      },
      actorUserId,
      { skipIdentity: true, skipLock: true }
    );
    seatedAtDestination = true;

    await fastify.prisma.tournamentEntry.update({
      where: { id: player.entryId },
      data: { currentTableId: destTableId, currentSeat: destSeat },
    });
  } catch (error) {
    // Rollback: if we stood but SIT failed, re-seat the player at their original seat
    if (stood) {
      try {
        if (seatedAtDestination) {
          await fastify.gameManager.processAction(
            destTableId,
            { type: ActionType.STAND, playerId: player.userId },
            actorUserId,
            { skipIdentity: true, skipLock: true }
          );
        }
        await fastify.gameManager.processAction(
          origTableId,
          {
            type: ActionType.SIT,
            playerId: player.userId,
            playerName: player.username,
            seat: origSeat,
            stack: player.stack,
          },
          actorUserId,
          { skipIdentity: true, skipLock: true }
        );
      } catch (rollbackError) {
        // Player is stranded — log critical error and surface
        fastify.log.error(
          {
            playerId: player.userId,
            origTableId,
            origSeat,
            destTableId,
            destSeat,
            error: rollbackError,
          },
          "CRITICAL: Failed to rollback player during tournament reconciliation — player may be stranded"
        );
        throw Object.assign(
          new Error(`Reconciliation rollback failed for player ${player.userId}`),
          { statusCode: 500, code: "TOURNAMENT_RECONCILE_ROLLBACK_FAILED", cause: rollbackError }
        );
      }
    }
    throw error;
  }
}

async function reconcileTournamentState(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string,
  remainingIterations: number
): Promise<void> {
  if (remainingIterations <= 0) {
    fastify.log.warn(
      { tournamentId, iterations: MAX_RECONCILE_ITERATIONS },
      "Reconciliation iteration limit reached; deferring remaining work to next reconcile call"
    );
    return;
  }

  const t = await fastify.prisma.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    include: { entries: true, tables: true },
  });
  if (t.status !== "RUNNING") return;

  const tableMax = t.tableMaxPlayers;
  const tolerance = t.balancingTolerance;

  // 1. Collect live stacks across all tournament tables
  interface LivePlayer {
    entryId: string;
    userId: string;
    username: string;
    stack: number;
    tableId: string;
    seat: number;
  }

  const allLivePlayers: LivePlayer[] = [];
  const tablePlayerCounts = new Map<string, number>();
  const seenActiveUsers = new Set<string>();
  const eliminatedUserIds = new Set<string>();
  const completedTables = new Set<string>();

  for (const table of t.tables) {
    try {
      const state = await fastify.gameManager.getState(table.id);
      if (!state) throw new Error(`Table ${table.id} state not found`);

      let liveCount = 0;
      const players = state.players;
      const completed = Boolean(state.winners?.length && state.actionTo == null);
      if (completed) completedTables.add(table.id);
      for (let seatIdx = 0; seatIdx < players.length; seatIdx++) {
        const p = players[seatIdx];
        if (p) {
          // Find the tournament entry for this player
          const entry = t.entries.find(
            (e: { userId: string; status: string; id: string }) =>
              e.userId === p.id && e.status === "ACTIVE"
          );
          if (entry) {
            if (seenActiveUsers.has(p.id)) {
              throw new Error("Duplicate tournament seat assignment");
            }
            seenActiveUsers.add(p.id);
            // An all-in player with no uncommitted stack is still competing.
            // Elimination is authoritative only after chips have been awarded.
            if (completed && p.stack === 0) {
              eliminatedUserIds.add(p.id);
              continue;
            }
            allLivePlayers.push({
              entryId: entry.id,
              userId: p.id,
              username: p.name,
              stack: p.stack,
              tableId: table.id,
              seat: seatIdx,
            });
            liveCount++;
          }
        }
      }
      tablePlayerCounts.set(table.id, liveCount);
    } catch (error) {
      throw Object.assign(new Error(`Unable to read tournament table state for ${table.id}`), {
        statusCode: 503,
        code: "TOURNAMENT_STATE_UNAVAILABLE",
        cause: error,
      });
    }
  }

  for (const entry of t.entries) {
    if (
      entry.status === "ACTIVE" &&
      !seenActiveUsers.has(entry.userId) &&
      entry.currentTableId &&
      completedTables.has(entry.currentTableId)
    ) {
      // Settled pending departures may already have been removed by the engine.
      eliminatedUserIds.add(entry.userId);
    }
  }
  if (
    allLivePlayers.length === 0 ||
    t.entries.some(
      (entry) =>
        entry.status === "ACTIVE" &&
        !seenActiveUsers.has(entry.userId) &&
        !eliminatedUserIds.has(entry.userId)
    )
  ) {
    throw Object.assign(new Error("Tournament seat assignments are inconsistent"), {
      statusCode: 503,
      code: "TOURNAMENT_STATE_UNAVAILABLE",
    });
  }

  // 2. Update eliminated entries with placements
  const eliminatedEntries = t.entries.filter(
    (e: { status: string; userId: string }) =>
      e.status === "ACTIVE" && eliminatedUserIds.has(e.userId)
  );

  if (eliminatedEntries.length > 0) {
    const previouslyPlaced = t.entries.filter(
      (e: { placement: number | null }) => e.placement != null
    ).length;
    const highestPlacementToAssign = t.entries.length - previouslyPlaced;

    for (let i = 0; i < eliminatedEntries.length; i++) {
      await fastify.prisma.tournamentEntry.update({
        where: { id: eliminatedEntries[i].id },
        data: { status: "ELIMINATED", placement: highestPlacementToAssign - i },
      });
    }
  }

  // Clear settled busted seats through the engine, not by editing snapshots.
  // This preserves chip conservation and makes the seat available to the director.
  for (const table of t.tables) {
    const state = await fastify.gameManager.getState(table.id);
    if (!state.winners?.length || state.actionTo != null) continue;
    for (const player of state.players) {
      if (player && player.stack === 0) {
        await fastify.gameManager.processAction(
          table.id,
          { type: ActionType.STAND, playerId: player.id },
          actorUserId,
          { skipIdentity: true, skipLock: true }
        );
      }
    }
  }

  const liveCount = allLivePlayers.length;
  if (liveCount === 0) return;

  // 3. If live players fit on one table, merge to final table
  if (liveCount <= tableMax) {
    // Only the primary table should remain; designate it as the final table
    const finalTableId = t.tableId;

    // Check if the primary table is already in the tables list
    const primaryTable = t.tables.find((tb: { id: string }) => tb.id === finalTableId);
    if (!primaryTable) {
      // Re-activate or ensure primary table exists
      await fastify.prisma.table.update({
        where: { id: finalTableId },
        data: { status: "ACTIVE" },
      });
    }

    // Move all players not already on the final table
    for (const player of allLivePlayers) {
      if (player.tableId === finalTableId) continue;
      if (!(await canMovePlayer(fastify, player.tableId))) continue;
      if (!(await canMovePlayer(fastify, finalTableId))) continue;

      // Pre-validate destination has an open seat before standing
      let destSeat: number;
      try {
        destSeat = await findOpenSeat(fastify, finalTableId);
      } catch {
        // No open seat on final table — skip this player for now
        fastify.log.warn(
          { tournamentId, playerId: player.userId, finalTableId },
          "Cannot merge player to final table: no open seat available"
        );
        continue;
      }

      await safeMovePlayer(fastify, player, finalTableId, destSeat, actorUserId);
    }

    // Never close a table with players still assigned to it (including deferred
    // moves while either hand is in progress).
    for (const table of t.tables) {
      if (table.id !== finalTableId) {
        await closeEmptyTournamentTable(fastify, table.id);
      }
    }

    return;
  }

  // 4. Rebalance: break short tables and balance player counts
  // Only act on tables that have completed their current hand
  const movableTables = new Set<string>();
  for (const [tableId] of tablePlayerCounts) {
    if (await canMovePlayer(fastify, tableId)) {
      movableTables.add(tableId);
    }
  }

  const tablesWithLivePlayers = Array.from(tablePlayerCounts.entries()).filter(
    ([, count]) => count > 0
  );

  // Consolidate completed tables to the minimum capacity, not just tables with
  // one survivor. Four half-full tables must become two, then one final table.
  const requiredTables = Math.ceil(liveCount / tableMax);
  const orderedTables = [...tablesWithLivePlayers].sort(
    (a, b) =>
      Number(b[0] === t.tableId) - Number(a[0] === t.tableId) ||
      b[1] - a[1] ||
      a[0].localeCompare(b[0])
  );
  const destinations = orderedTables.slice(0, requiredTables);
  for (const [sourceId] of orderedTables.slice(requiredTables)) {
    if (!movableTables.has(sourceId)) continue;
    let moved = false;
    for (const player of allLivePlayers.filter((candidate) => candidate.tableId === sourceId)) {
      const target = destinations.find(
        ([id]) => movableTables.has(id) && (tablePlayerCounts.get(id) ?? 0) < tableMax
      );
      if (!target) break;
      const seat = await findOpenSeat(fastify, target[0]);
      await safeMovePlayer(fastify, player, target[0], seat, actorUserId);
      moved = true;
      tablePlayerCounts.set(target[0], (tablePlayerCounts.get(target[0]) ?? 0) + 1);
      tablePlayerCounts.set(sourceId, (tablePlayerCounts.get(sourceId) ?? 0) - 1);
    }
    await closeEmptyTournamentTable(fastify, sourceId);
    if (moved) {
      await reconcileTournamentState(fastify, tournamentId, actorUserId, remainingIterations - 1);
      return;
    }
  }
  for (const [id, count] of tablePlayerCounts) {
    if (count === 0) await closeEmptyTournamentTable(fastify, id);
  }

  // Find max and min player counts
  let maxCount = 0;
  let minCount = Infinity;
  let maxTableId = "";
  let minTableId = "";

  for (const [tableId, count] of tablesWithLivePlayers) {
    if (count > maxCount) {
      maxCount = count;
      maxTableId = tableId;
    }
    if (count < minCount) {
      minCount = count;
      minTableId = tableId;
    }
  }

  // 5. Break short tables: if a table has only 1 live player, move them
  for (const [tableId, count] of tablesWithLivePlayers) {
    if (count <= 1 && movableTables.has(tableId)) {
      // Find another table with most open seats
      const targetTable = t.tables.find(
        (tb: { id: string; status: string }) =>
          tb.id !== tableId &&
          tb.status !== "CLOSED" &&
          movableTables.has(tb.id) &&
          (tablePlayerCounts.get(tb.id) ?? 0) < tableMax
      );
      if (targetTable) {
        const playersToMove = allLivePlayers.filter((p) => p.tableId === tableId);
        for (const player of playersToMove) {
          // Pre-validate destination has an open seat
          let openSeat: number;
          try {
            openSeat = await findOpenSeat(fastify, targetTable.id);
          } catch {
            fastify.log.warn(
              { tournamentId, playerId: player.userId, targetTableId: targetTable.id },
              "Cannot break short table: no open seat on target table"
            );
            continue;
          }
          await safeMovePlayer(fastify, player, targetTable.id, openSeat, actorUserId);
        }
        // Close the short table
        if (!(await closeEmptyTournamentTable(fastify, tableId))) continue;
        // Re-run reconciliation after moving
        await reconcileTournamentState(fastify, tournamentId, actorUserId, remainingIterations - 1);
        return;
      }
    }
  }

  // 6. Rebalance if max - min > tolerance
  if (
    maxCount - minCount > tolerance &&
    movableTables.has(maxTableId) &&
    movableTables.has(minTableId) &&
    maxTableId !== minTableId
  ) {
    // Move one player from max table to min table
    const playerToMove = allLivePlayers.find((p) => p.tableId === maxTableId);
    if (playerToMove) {
      // Pre-validate destination has an open seat
      let destSeat: number;
      try {
        destSeat = await findOpenSeat(fastify, minTableId);
      } catch {
        fastify.log.warn(
          { tournamentId, maxTableId, minTableId },
          "Cannot rebalance: no open seat on min table"
        );
        return;
      }
      await safeMovePlayer(fastify, playerToMove, minTableId, destSeat, actorUserId);
    }
  }
}

/**
 * Check if a table is in a state where players can be moved
 * (hand completed and no pending action).
 */
async function canMovePlayer(fastify: FastifyInstance, tableId: string): Promise<boolean> {
  try {
    const state = await fastify.gameManager.getState(tableId);
    if (!state) return false;
    // A zero uncommitted stack may be all-in, not busted. Never infer a hand
    // boundary from stack count: only undealt tables or settled hands are safe.
    if (state.handNumber === 0 && state.actionTo == null) return true;
    const winners = state.winners;
    const actionTo = state.actionTo;
    return Boolean(winners && winners.length > 0 && actionTo == null);
  } catch {
    return false;
  }
}

async function closeEmptyTournamentTable(
  fastify: FastifyInstance,
  tableId: string
): Promise<boolean> {
  const assigned = await fastify.prisma.tournamentEntry.count({
    where: { currentTableId: tableId, status: "ACTIVE" },
  });
  if (assigned > 0) return false;
  const state = await fastify.gameManager.getState(tableId);
  if (state.players.some((player) => player && player.stack > 0)) return false;
  const table = await fastify.prisma.table.findUnique({
    where: { id: tableId },
    select: { tournamentId: true },
  });
  await fastify.prisma.table.update({ where: { id: tableId }, data: { status: "CLOSED" } });
  // Durable audit of the closed table. Fingerprint is stable per table, so a
  // repeated close attempt appends no duplicate event.
  if (table?.tournamentId) {
    try {
      await recordTournamentEvent(fastify.prisma, {
        tournamentId: table.tournamentId,
        type: "TABLE_CLOSED",
        payload: { tableId },
        stateFingerprint: `table-closed:${tableId}`,
        requestRef: null,
      });
    } catch (error) {
      fastify.log.warn(
        { tournamentId: table.tournamentId, tableId, error },
        "Failed to record tournament table-close audit event"
      );
    }
  }
  return true;
}

/**
 * Find an open seat on a table.
 */
async function findOpenSeat(fastify: FastifyInstance, tableId: string): Promise<number> {
  const state = await fastify.gameManager.getState(tableId);
  if (!state) throw new Error(`Table ${tableId} state not found`);

  const players = state.players;
  for (let i = 0; i < players.length; i++) {
    if (players[i] === null) return i;
  }
  throw new Error(`No open seats on table ${tableId}`);
}

export const tournamentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", async (): Promise<{ tournaments: TournamentListItem[] }> => {
    const tournaments = await fastify.prisma.tournament.findMany({
      where: { status: { in: ["REGISTRATION", "RUNNING"] } },
      include: { entries: true },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: config.TOURNAMENT_LISTING_PAGE_SIZE,
    });

    return { tournaments: tournaments.map(toTournamentListItem) };
  });

  fastify.post<{ Body: CreateTournamentRequest }>(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = CreateTournamentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });

      const config = parsed.data;

      // Validate blind structure (schema enforces strictly increasing, but
      // also validate at runtime in case schema is bypassed or outdated)
      if (config.blindStructure) {
        try {
          validateBlindStructure(config.blindStructure);
        } catch (error: unknown) {
          return reply.code(400).send({ error: errorMessage(error) });
        }
      }
      const blindStructure =
        config.blindStructure ?? defaultBlindStructure(config.smallBlind, config.bigBlind);
      const blindStructureJson = blindStructure.map((level) => ({
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
        ante: level.ante,
      }));

      // Create primary table (maxPlayers for engine = min of tableMaxPlayers or maxPlayers)
      const engineMax = Math.min(config.tableMaxPlayers, config.maxPlayers);
      const tableId = await fastify.gameManager.createTable({
        name: config.name,
        mode: "TOURNAMENT",
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        maxPlayers: engineMax,
        blindStructure: blindStructureJson,
        startingStack: config.startingStack,
      });

      let tournament: { id: string };
      try {
        tournament = await fastify.prisma.$transaction(async (tx) => {
          const created = await tx.tournament.create({
            data: {
              name: config.name,
              creatorId: request.user.userId,
              tableId,
              buyIn: config.buyIn,
              fee: config.fee,
              startingStack: config.startingStack,
              maxPlayers: config.maxPlayers,
              tableMaxPlayers: config.tableMaxPlayers,
              balancingTolerance: config.balancingTolerance,
              blindStructure: blindStructureJson,
              payoutPercentages: config.payoutPercentages,
              startsAt: config.startsAt ? new Date(config.startsAt) : null,
            },
            select: { id: true },
          });
          await tx.table.update({
            where: { id: tableId },
            data: { tournamentId: created.id },
          });
          return created;
        });
      } catch (error) {
        await fastify.prisma.table.delete({ where: { id: tableId } }).catch(() => undefined);
        await fastify.redis.del(`table:${tableId}`).catch(() => undefined);
        throw error;
      }

      await fastify.auditManager.record({
        actorId: request.user.userId,
        action: "TOURNAMENT_CREATE",
        resource: `tournament:${tournament.id}`,
        request,
        metadata: { tableId, buyIn: config.buyIn, fee: config.fee },
      });

      return { tournamentId: tournament.id, tableId };
    }
  );

  fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    let includePrivateFields = false;
    if (request.headers.authorization) {
      try {
        await request.jwtVerify();
        const { jti } = request.user;
        const session = await fastify.prisma.session.findUnique({ where: { jti } });
        if (session === null || session.revoked || session.expiresAt <= new Date()) {
          throw new Error("Session invalid");
        }
        includePrivateFields = true;
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }
    const tournament = await fastify.prisma.tournament.findUnique({
      where: { id: request.params.id },
      include: {
        entries: { include: { user: { select: { username: true } } } },
        tables: { select: { id: true, status: true, state: true } },
      },
    });
    if (!tournament) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });

    // Compute player counts for each table
    const tableInfos: TournamentTableInfo[] = await Promise.all(
      tournament.tables.map(async (table) => {
        let playerCount = 0;
        try {
          const state = await fastify.gameManager.getState(table.id);
          playerCount = state.players.filter(Boolean).length;
        } catch {
          if (table.state) {
            try {
              const state = typeof table.state === "string" ? JSON.parse(table.state) : table.state;
              const players = (state as { players: unknown[] }).players ?? [];
              playerCount = players.filter(Boolean).length;
            } catch {
              // ignore parse errors
            }
          }
        }
        return { id: table.id, status: table.status, playerCount };
      })
    );

    const details: TournamentDetails = {
      ...toTournamentListItem(tournament),
      blindStructure: tournament.blindStructure as unknown as BlindLevel[],
      payoutPercentages: tournament.payoutPercentages as unknown as number[],
      tables: tableInfos,
      startedAt: tournament.startedAt?.toISOString() ?? null,
      finishedAt: tournament.finishedAt?.toISOString() ?? null,
      entries: tournament.entries.map((entry) => ({
        id: entry.id,
        ...(includePrivateFields ? { userId: entry.userId, username: entry.user.username } : {}),
        seat: entry.seat,
        status: entry.status,
        placement: entry.placement,
        prize: entry.prize,
        currentTableId: entry.currentTableId,
        currentSeat: entry.currentSeat,
      })),
    };

    return { tournament: details };
  });

  fastify.post<{ Params: { id: string }; Body: RegisterTournamentRequest }>(
    "/:id/register",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = RegisterTournamentRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });

      const { id } = request.params;
      const { userId } = request.user;
      const { seat, idempotencyKey } = parsed.data;

      const idem = await fastify.idempotencyManager.run({
        key: idempotencyKey,
        scope: `tournament-register:${id}`,
        userId,
        requestHash: fastify.idempotencyManager.hash({ id, seat }),
        handler: async () => {
          const tournament = await fastify.prisma.tournament.findUniqueOrThrow({
            where: { id },
            include: { entries: true },
          });
          if (tournament.status !== "REGISTRATION") {
            throw Object.assign(new Error("Tournament registration is closed"), {
              statusCode: 400,
              code: "TOURNAMENT_REGISTRATION_CLOSED",
            });
          }
          if (seat >= tournament.maxPlayers) {
            throw Object.assign(new Error("Seat is outside tournament capacity"), {
              statusCode: 400,
              code: "INVALID_SEAT",
            });
          }
          if (tournament.entries.length >= tournament.maxPlayers) {
            throw Object.assign(new Error("Tournament is full"), {
              statusCode: 400,
              code: "TOURNAMENT_FULL",
            });
          }
          if (tournament.entries.some((entry) => entry.userId === userId)) {
            throw Object.assign(new Error("User is already registered for this tournament"), {
              statusCode: 409,
              code: "TOURNAMENT_ALREADY_REGISTERED",
            });
          }
          if (tournament.entries.some((entry) => entry.seat === seat)) {
            throw Object.assign(new Error("Tournament seat is already registered"), {
              statusCode: 409,
              code: "TOURNAMENT_SEAT_TAKEN",
            });
          }

          // Debit chips only — do NOT sit into engine tables at registration.
          // PLAY_CHIPS moves available chips into the tournament pool; an
          // ASSET-backed tournament performs the exact persisted conversion.
          const houseUserId = await getHouseUserId(fastify.prisma);
          try {
            await fastify.prisma.$transaction(async (tx) => {
              await tx.tournamentEntry.create({
                data: { tournamentId: id, userId, seat },
              });
              await fastify.financialManager.applyTournamentRegistration(
                tx,
                userId,
                id,
                BigInt(tournament.buyIn),
                BigInt(tournament.fee),
                { idempotencyKey: `tournament-register:${id}:${userId}`, operatorId: houseUserId }
              );
              await tx.tournament.update({
                where: { id },
                data: { prizePool: { increment: tournament.buyIn } },
              });
            });
          } catch (error) {
            if (error instanceof InsufficientFundsError) {
              throw Object.assign(new Error("Insufficient funds for tournament registration"), {
                statusCode: 402,
                code: "INSUFFICIENT_FUNDS",
              });
            }
            throw error;
          }

          return { success: true };
        },
      });

      await fastify.auditManager.record({
        actorId: userId,
        action: "TOURNAMENT_REGISTER",
        resource: `tournament:${id}`,
        request,
        metadata: { seat, replayed: idem.replayed },
      });

      return idem.response;
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/start",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        return await startTournament(fastify, request.params.id, request.user.userId);
      } catch (error) {
        const err = error as { statusCode?: number; code?: string; message?: string };
        if (err.statusCode !== undefined && err.statusCode < 500) {
          return reply.code(err.statusCode).send({ error: err.code ?? err.message });
        }
        throw error;
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/reconcile",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const tournament = await fastify.prisma.tournament.findUnique({
        where: { id: request.params.id },
      });
      if (!tournament) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });
      if (tournament.status !== "RUNNING") {
        return reply.code(400).send({ error: "TOURNAMENT_NOT_RUNNING" });
      }

      await requireTournamentManager(fastify, tournament.id, request.user.userId);

      await reconcileTournament(fastify, tournament.id, request.user.userId);

      // Return updated tournament state
      const updated = await fastify.prisma.tournament.findUnique({
        where: { id: tournament.id },
        include: {
          entries: true,
          tables: { select: { id: true, status: true, state: true } },
        },
      });

      const tableInfos: TournamentTableInfo[] = await Promise.all(
        (updated?.tables ?? []).map(async (table) => {
          let playerCount = 0;
          try {
            const state = await fastify.gameManager.getState(table.id);
            playerCount = state.players.filter(Boolean).length;
          } catch {
            if (table.state) {
              try {
                const state =
                  typeof table.state === "string" ? JSON.parse(table.state) : table.state;
                const players = (state as { players: unknown[] }).players ?? [];
                playerCount = players.filter(Boolean).length;
              } catch {
                // ignore
              }
            }
          }
          return { id: table.id, status: table.status, playerCount };
        })
      );

      return {
        success: true,
        tables: tableInfos,
        entries: (updated?.entries ?? []).map((e) => ({
          id: e.id,
          userId: e.userId,
          seat: e.seat,
          status: e.status,
          placement: e.placement,
          prize: e.prize,
          currentTableId: e.currentTableId,
          currentSeat: e.currentSeat,
        })),
      };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/advance-blinds",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const tournament = await fastify.prisma.tournament.findUnique({
        where: { id: request.params.id },
        include: { tables: { where: { status: "ACTIVE" } } },
      });
      if (!tournament) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });
      if (tournament.status !== "RUNNING")
        return reply.code(400).send({ error: "TOURNAMENT_NOT_RUNNING" });

      await requireTournamentManager(fastify, tournament.id, request.user.userId);

      // Advance blinds on all active tables
      const results: Record<string, unknown> = {};
      for (const table of tournament.tables) {
        try {
          const state = await fastify.gameManager.processAction(
            table.id,
            { type: "NEXT_BLIND_LEVEL" } as Action,
            request.user.userId
          );
          results[table.id] = { blindLevel: state.blindLevel };
        } catch {
          results[table.id] = { error: "Failed to advance blinds" };
        }
      }

      // Update lastBlindAdvancedAt so the scheduler doesn't immediately re-advance
      await fastify.prisma.tournament.update({
        where: { id: tournament.id },
        data: { lastBlindAdvancedAt: new Date() },
      });

      return { results };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/settle",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        return await settleTournament(fastify, request.params.id, request.user.userId);
      } catch (error) {
        const err = error as {
          statusCode?: number;
          code?: string;
          message?: string;
          activePlayers?: number;
        };
        if (err.statusCode !== undefined && err.statusCode < 500) {
          return reply.code(err.statusCode).send({
            error: err.code ?? err.message,
            ...(err.activePlayers !== undefined ? { activePlayers: err.activePlayers } : {}),
          });
        }
        throw error;
      }
    }
  );
};
