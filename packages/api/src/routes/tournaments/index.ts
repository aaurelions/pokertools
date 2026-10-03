import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Action } from "@pokertools/engine";
import {
  CreateTournamentSchema,
  RegisterTournamentRequestSchema,
  type CreateTournamentRequest,
  type RegisterTournamentRequest,
} from "@pokertools/types";
import {
  defaultBlindStructure,
  toSafeChipNumber,
  validateBlindStructure,
  type BlindLevel,
} from "../../utils/tournaments.js";
import { config } from "../../config.js";
import { getHouseUserId } from "../../utils/house-user.js";
import { AppError, InsufficientFundsError } from "../../utils/errors.js";
import {
  requireTournamentManager,
  settleTournament,
  startTournament,
} from "../../services/tournament-lifecycle.js";
import { reconcileTournament } from "../../services/tournament-director.js";

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
  prizePool: bigint;
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
  prizePool: toSafeChipNumber(tournament.prizePool),
  startsAt: tournament.startsAt?.toISOString() ?? null,
});

/**
 * The public legacy tournament surface must never drive a tournament that is
 * the backing store of a generic competition, not even for an ADMIN. Shared
 * internal lifecycle services remain callable by CompetitionManager; this
 * rejection applies only to the legacy public routes.
 */
async function assertNotCompetitionManaged(
  fastify: FastifyInstance,
  tournamentId: string
): Promise<void> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { tournamentId },
    select: { id: true },
  });
  if (competition) {
    throw new AppError(
      "Tournament is managed by a competition",
      409,
      "COMPETITION_MANAGED_TOURNAMENT"
    );
  }
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
        prize: toSafeChipNumber(entry.prize),
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
                data: { prizePool: { increment: BigInt(tournament.buyIn) } },
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
        await assertNotCompetitionManaged(fastify, request.params.id);
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
      await assertNotCompetitionManaged(fastify, tournament.id);
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
          prize: toSafeChipNumber(e.prize),
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
      await assertNotCompetitionManaged(fastify, tournament.id);
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
        await assertNotCompetitionManaged(fastify, request.params.id);
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
