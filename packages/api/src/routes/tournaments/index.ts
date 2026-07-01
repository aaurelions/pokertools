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
  computeTournamentTableDistribution,
  computeTournamentPayouts,
  defaultBlindStructure,
  validateBlindStructure,
  MAX_RECONCILE_ITERATIONS,
  type BlindLevel,
} from "../../utils/tournaments.js";
import { config } from "../../config.js";

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

async function requireTournamentManager(
  fastify: FastifyInstance,
  tournamentId: string,
  actorUserId: string
) {
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
  const lock = await fastify.redlock.acquire([`lock:tournament:${tournamentId}`], 30000);
  try {
    await reconcileTournamentState(fastify, tournamentId, actorUserId, MAX_RECONCILE_ITERATIONS);
  } finally {
    await lock.release();
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

  try {
    await fastify.gameManager.processAction(
      origTableId,
      { type: ActionType.STAND, playerId: player.userId },
      actorUserId,
      { skipIdentity: true }
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
      { skipIdentity: true }
    );

    await fastify.prisma.tournamentEntry.update({
      where: { id: player.entryId },
      data: { currentTableId: destTableId, currentSeat: destSeat },
    });
  } catch (error) {
    // Rollback: if we stood but SIT failed, re-seat the player at their original seat
    if (stood) {
      try {
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
          { skipIdentity: true }
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

  for (const table of t.tables) {
    try {
      const state = await fastify.gameManager.getState(table.id);
      if (!state) throw new Error(`Table ${table.id} state not found`);

      let liveCount = 0;
      const players = state.players;
      for (let seatIdx = 0; seatIdx < players.length; seatIdx++) {
        const p = players[seatIdx];
        if (p && p.stack > 0) {
          // Find the tournament entry for this player
          const entry = t.entries.find(
            (e: { userId: string; status: string; id: string }) =>
              e.userId === p.id && e.status === "ACTIVE"
          );
          if (entry) {
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

  // 2. Update eliminated entries with placements
  const liveUserIds = new Set(allLivePlayers.map((p) => p.userId));
  const eliminatedEntries = t.entries.filter(
    (e: { status: string; userId: string }) => e.status === "ACTIVE" && !liveUserIds.has(e.userId)
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

    // Close all non-final tables
    for (const table of t.tables) {
      if (table.id !== finalTableId) {
        await fastify.prisma.table.update({
          where: { id: table.id },
          data: { status: "CLOSED" },
        });
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
        (tb: { id: string }) => tb.id !== tableId && (tablePlayerCounts.get(tb.id) ?? 0) < tableMax
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
        await fastify.prisma.table.update({
          where: { id: tableId },
          data: { status: "CLOSED" },
        });
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
    // Tournament seats may normally be moved only after a completed hand. A table
    // with one or fewer live stacks is also safe to break because no further
    // betting action can alter relative stacks on that table.
    const livePlayers = state.players.filter((player) => player && player.stack > 0).length;
    if (livePlayers <= 1) return true;
    const winners = state.winners;
    const actionTo = state.actionTo;
    return Boolean(winners && winners.length > 0 && actionTo == null);
  } catch {
    return false;
  }
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
      take: 100,
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

          const totalCost = tournament.buyIn + tournament.fee;
          const totalCostBigInt = BigInt(totalCost);

          // Debit MAIN only — do NOT sit into engine tables at registration
          await fastify.prisma.$transaction(async (tx) => {
            const mainAccount = await tx.account.findUniqueOrThrow({
              where: {
                userId_currency_type: { userId, currency: config.DEFAULT_CURRENCY, type: "MAIN" },
              },
            });
            if (mainAccount.balance < totalCostBigInt) {
              throw Object.assign(new Error("Insufficient funds for tournament registration"), {
                statusCode: 402,
                code: "INSUFFICIENT_FUNDS",
              });
            }

            await tx.tournamentEntry.create({
              data: { tournamentId: id, userId, seat },
            });
            await tx.ledgerEntry.createMany({
              data: [
                {
                  accountId: mainAccount.id,
                  amount: -BigInt(tournament.buyIn),
                  type: "TOURNAMENT_BUY_IN",
                  referenceId: id,
                },
                ...(tournament.fee > 0
                  ? [
                      {
                        accountId: mainAccount.id,
                        amount: -BigInt(tournament.fee),
                        type: "TOURNAMENT_FEE" as const,
                        referenceId: id,
                      },
                    ]
                  : []),
              ],
            });
            await tx.account.update({
              where: { id: mainAccount.id },
              data: { balance: { decrement: totalCostBigInt } },
            });
            await tx.tournament.update({
              where: { id },
              data: { prizePool: { increment: tournament.buyIn } },
            });
          });

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
      const tournament = await fastify.prisma.tournament.findUnique({
        where: { id: request.params.id },
        include: { entries: { include: { user: { select: { username: true } } } } },
      });
      if (!tournament) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });
      if (tournament.status !== "REGISTRATION") {
        return reply.code(400).send({ error: "TOURNAMENT_ALREADY_STARTED" });
      }
      if (tournament.entries.length < 2) {
        return reply.code(400).send({ error: "TOURNAMENT_REQUIRES_TWO_PLAYERS" });
      }

      const registeredEntries = tournament.entries.filter((e) => e.status === "REGISTERED");
      const playerCount = registeredEntries.length;

      // Compute balanced distribution
      await requireTournamentManager(fastify, tournament.id, request.user.userId);

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
        return reply.code(400).send({ error: errorMessage(error) });
      }

      let distribution: number[];
      try {
        distribution = computeTournamentTableDistribution(playerCount, tournament.tableMaxPlayers);
      } catch (error: unknown) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      const lock = await fastify.redlock.acquire([`lock:tournament:${tournament.id}`], 30000);
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
              request.user.userId,
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
            await fastify.gameManager.processAction(
              tableId,
              { type: "DEAL" } as Action,
              request.user.userId
            );
          }
        }

        return { success: true, tableIds, distribution };
      } catch (error) {
        for (const seated of seatedPlayers.reverse()) {
          await fastify.gameManager
            .processAction(
              seated.tableId,
              { type: ActionType.STAND, playerId: seated.userId },
              request.user.userId,
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
        await lock.release();
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
      const tournamentId = request.params.id;

      // Quick pre-check outside lock for early exit
      const preCheck = await fastify.prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: { status: true },
      });
      if (!preCheck) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });

      // Return idempotent settlement details if already FINISHED
      if (preCheck.status === "FINISHED") {
        const finishedTournament = await fastify.prisma.tournament.findUnique({
          where: { id: tournamentId },
          include: {
            entries: {
              where: { prize: { gt: 0 } },
              include: { user: { select: { username: true } } },
              orderBy: { placement: "asc" },
            },
          },
        });
        if (finishedTournament) {
          const winnerEntry = finishedTournament.entries.find((e) => e.placement === 1);
          return {
            success: true,
            winnerUserId: winnerEntry?.userId ?? null,
            prize: winnerEntry?.prize ?? 0,
            payouts: finishedTournament.entries.map((e) => ({
              userId: e.userId,
              placement: e.placement,
              amount: e.prize,
            })),
          };
        }
      }

      if (preCheck.status !== "RUNNING") {
        return reply.code(400).send({ error: "TOURNAMENT_NOT_RUNNING" });
      }

      await requireTournamentManager(fastify, tournamentId, request.user.userId);

      // Acquire tournament lock before reading state and executing settlement
      const lock = await fastify.redlock.acquire([`lock:tournament:${tournamentId}`], 30000);
      try {
        // Re-fetch full tournament state under lock
        const tournament = await fastify.prisma.tournament.findUnique({
          where: { id: tournamentId },
          include: { entries: true, tables: { where: { status: { not: "CLOSED" } } } },
        });
        if (!tournament) return reply.code(404).send({ error: "TOURNAMENT_NOT_FOUND" });

        // Double-check under lock: if another request settled this already, return idempotent result
        if (tournament.status === "FINISHED") {
          const finishedEntries = await fastify.prisma.tournamentEntry.findMany({
            where: { tournamentId, prize: { gt: 0 } },
            include: { user: { select: { username: true } } },
            orderBy: { placement: "asc" },
          });
          const winnerEntry = finishedEntries.find((e) => e.placement === 1);
          return {
            success: true,
            winnerUserId: winnerEntry?.userId ?? null,
            prize: winnerEntry?.prize ?? 0,
            payouts: finishedEntries.map((e) => ({
              userId: e.userId,
              placement: e.placement,
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
            throw Object.assign(
              new Error(`Unable to read tournament table state for ${table.id}`),
              {
                statusCode: 503,
                code: "TOURNAMENT_STATE_UNAVAILABLE",
                cause: error,
              }
            );
          }
        }

        const activeEntries = tournament.entries.filter(
          (entry) => entry.status === "ACTIVE" && (stacks.get(entry.userId) ?? 0) > 0
        );

        if (activeEntries.length !== 1) {
          return reply.code(400).send({
            error: "TOURNAMENT_NOT_COMPLETE",
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

        await fastify.prisma.$transaction(async (tx) => {
          for (const payout of payouts) {
            const mainAccount = await tx.account.findUniqueOrThrow({
              where: {
                userId_currency_type: {
                  userId: payout.entry.userId,
                  currency: config.DEFAULT_CURRENCY,
                  type: "MAIN",
                },
              },
            });
            await tx.ledgerEntry.create({
              data: {
                accountId: mainAccount.id,
                amount: BigInt(payout.amount),
                type: "TOURNAMENT_PAYOUT",
                referenceId: tournament.id,
                metadata: { placement: payout.placement },
              },
            });
            await tx.account.update({
              where: { id: mainAccount.id },
              data: { balance: { increment: BigInt(payout.amount) } },
            });
          }

          await tx.tournamentEntry.update({
            where: { id: winner.id },
            data: {
              status: payouts.some((payout) => payout.entry.id === winner.id)
                ? "PAID"
                : "ELIMINATED",
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
        });

        await fastify.auditManager.record({
          actorId: request.user.userId,
          action: "TOURNAMENT_SETTLE",
          resource: `tournament:${tournament.id}`,
          request,
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
        await lock.release();
      }
    }
  );
};
