import type { FastifyInstance } from "fastify";
import { randomInt } from "node:crypto";
import { ActionType } from "@pokertools/types";
import type { Prisma } from "../../generated/prisma/index.js";
import type {
  CancelCompetitionResponse,
  Competition,
  CompetitionEntrant,
  CompetitionPlacement,
  CompetitionPrizeStatus,
  CreateCompetitionRequest,
  IssuedAgentCredential,
  OptInCompetitionResponse,
  SettleCompetitionResponse,
  StartCompetitionResponse,
} from "@pokertools/types";
import { AppError, InsufficientFundsError } from "../utils/errors.js";
import { competitionSponsorPrincipalIds, config } from "../config.js";
import { defaultBlindStructure } from "../utils/tournaments.js";
import { settleTournament } from "./tournament-lifecycle.js";
import { recordTournamentEvent } from "./tournament-events.js";
import { reconcileTournament } from "./tournament-director.js";
import type { AuthenticatedPrincipal } from "./principal-manager.js";

/**
 * Generic competition capability.
 *
 * A competition is provisioned into the authoritative tournament/game
 * machinery: it owns exactly one backing Tournament (zero buy-in/fee for
 * NONFINANCIAL) and the roster is inserted as authoritative TournamentEntry
 * rows with server-assigned seats. Registration seats are a server CSPRNG
 * Fisher-Yates permutation of `0..n-1`, so the order of the roster array never
 * controls a seat. Start seats every entrant and deals inside one database
 * transaction; there is no second poker runner and no partially seated public
 * table.
 *
 * ASSET economics are explicit atomic journals only:
 * - each configured WALLET payer opts in and pays their entry into the
 *   competition's own entry reserve (never directly to the sponsor), so the
 *   sponsor cannot spend value that is still refundable;
 * - start transfers every held entry to the authorized sponsor's operator
 *   account exactly once;
 * - the fixed sponsor prize is reserved before admission and settled once
 *   (paid to a WALLET winner, released when no financial winner exists);
 * - prestart cancellation refunds every held entry, releases the prize
 *   reservation and cancels the backing tournament/table durably. It is
 *   risk-reducing: never gated on readiness or ACTIVE assets;
 * - SERVICE entrants never move value and are never financial owners;
 * - paid admission (create/opt-in/start) fails closed unless the central
 *   platform readiness reports financial READY and the explicit feature flag
 *   is enabled. Settlement and cancellation are risk-reducing and never trap
 *   reserved value.
 *
 * `REGISTRATION -> RUNNING` and `REGISTRATION -> CANCELLED` are serialized on
 * the competition row (fresh reads inside the transaction), so exactly one
 * wins; a start or cancel that loses reports the winner's durable state.
 */

interface CompetitionRow {
  id: string;
  name: string;
  mode: "NONFINANCIAL" | "ASSET";
  status: "REGISTRATION" | "RUNNING" | "FINISHED" | "CANCELLED";
  organizerId: string;
  tournamentId: string;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  entryAssetId: string | null;
  entryAmountAtomic: string | null;
  prizeAssetId: string | null;
  prizeAmountAtomic: string | null;
  sponsorId: string | null;
  prizeStatus: CompetitionPrizeStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  entrants: Array<{
    principalId: string;
    kind: "WALLET" | "SERVICE";
    seat: number;
    entryState: "NOT_REQUIRED" | "PENDING" | "PAID" | "REFUNDED";
    entryAmountAtomic: string | null;
    entryJournalId: string | null;
    refundJournalId: string | null;
  }>;
}

/** Canonical, privacy-preserving wire projection. */
export function toWireCompetition(
  competition: CompetitionRow,
  tableId: string,
  settlementReady: boolean
): Competition {
  const entrants: CompetitionEntrant[] = competition.entrants.map((entrant) => ({
    principalId: entrant.principalId,
    kind: entrant.kind,
    seat: entrant.seat,
    entryState: entrant.entryState,
  }));

  const terms =
    competition.mode === "ASSET" &&
    competition.entryAssetId !== null &&
    competition.entryAmountAtomic !== null &&
    competition.prizeAssetId !== null &&
    competition.prizeAmountAtomic !== null &&
    competition.sponsorId !== null
      ? {
          entry: {
            assetId: competition.entryAssetId,
            amountAtomic: competition.entryAmountAtomic,
            payers: competition.entrants
              .filter(
                (entrant): entrant is typeof entrant & { entryAmountAtomic: string } =>
                  entrant.entryAmountAtomic !== null
              )
              .map((entrant) => ({
                principalId: entrant.principalId,
                amountAtomic: entrant.entryAmountAtomic,
              })),
          },
          prize: {
            assetId: competition.prizeAssetId,
            amountAtomic: competition.prizeAmountAtomic,
            sponsorPrincipalId: competition.sponsorId,
          },
        }
      : null;

  return {
    id: competition.id,
    name: competition.name,
    mode: competition.mode,
    status: competition.status,
    tableId,
    organizerPrincipalId: competition.organizerId,
    maxEntrants: competition.entrants.length,
    startingStack: competition.startingStack,
    smallBlind: competition.smallBlind,
    bigBlind: competition.bigBlind,
    entrants,
    terms,
    prizeStatus: competition.prizeStatus,
    settlementReady,
    createdAt: competition.createdAt.toISOString(),
    startedAt: competition.startedAt ? competition.startedAt.toISOString() : null,
    finishedAt: competition.finishedAt ? competition.finishedAt.toISOString() : null,
    cancelledAt: competition.cancelledAt ? competition.cancelledAt.toISOString() : null,
  };
}

/**
 * Authorize an orchestration actor over one competition: an ADMIN wallet may
 * manage any competition; an orchestration SERVICE credential only its own.
 */
export function assertCompetitionOwner(
  actor: AuthenticatedPrincipal,
  competition: { organizerId: string }
): void {
  if (actor.isOperator) return;
  if (competition.organizerId === actor.id) return;
  throw new AppError("Competition belongs to another organizer", 403, "COMPETITION_FORBIDDEN");
}

/**
 * Authorized sponsor delegation: the organizer itself when it is a WALLET, or
 * a fixed platform sponsor principal configured out of band. An orchestration
 * principal can never direct an arbitrary wallet to finance a prize.
 */
export function assertAuthorizedSponsor(input: {
  organizer: AuthenticatedPrincipal;
  sponsorId: string;
  sponsorKind: "WALLET" | "SERVICE";
}): void {
  if (input.sponsorKind !== "WALLET") {
    throw new AppError(
      "Competition sponsor must be a wallet principal (SERVICE never owns value)",
      400,
      "COMPETITION_SPONSOR_NOT_WALLET"
    );
  }
  const allowlisted = competitionSponsorPrincipalIds().has(input.sponsorId);
  const organizerIsWallet = input.organizer.kind === "WALLET";
  if (allowlisted || (organizerIsWallet && input.sponsorId === input.organizer.id)) return;
  throw new AppError(
    "Sponsor is not an authorized delegation (organizer-as-wallet or fixed platform sponsor)",
    403,
    "COMPETITION_SPONSOR_UNAUTHORIZED"
  );
}

/**
 * Paid admission is gated on the central platform financial readiness AND an
 * explicit feature enable. Never an environment bypass: the composed service
 * evaluates the real database, ledger, chain-quorum and custody evidence.
 */
async function assertPaidAdmissionReady(fastify: FastifyInstance): Promise<void> {
  if (!fastify.competitionPolicy.paidEnabled) {
    throw new AppError("Paid competition admission is disabled", 503, "COMPETITION_PAID_DISABLED");
  }
  const report = await fastify.platformReadiness.evaluate();
  if (report.financial.state !== "READY") {
    throw new AppError(
      "Platform financial readiness is not READY",
      503,
      "COMPETITION_FINANCIAL_NOT_READY"
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

function isPostgresDatabase(): boolean {
  return (config.DATABASE_URL ?? "").startsWith("postgres");
}

/**
 * Serialize lifecycle transitions for one competition on its durable row.
 * PostgreSQL takes an explicit row lock; SQLite serializes writers at the
 * database level. Every caller MUST re-read and re-check state after this.
 */
async function lockCompetitionRow(
  tx: Prisma.TransactionClient,
  competitionId: string
): Promise<void> {
  if (isPostgresDatabase()) {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Competition" WHERE "id" = $1 FOR UPDATE',
      competitionId
    );
  }
}

/**
 * Best-effort post-commit audit. An accepted, already-committed mutation is
 * never reported as failed because audit persistence was unavailable.
 */
async function recordAcceptedAudit(
  fastify: FastifyInstance,
  input: Parameters<FastifyInstance["auditManager"]["record"]>[0]
): Promise<void> {
  try {
    await fastify.auditManager.record(input);
  } catch {
    // The mutation is durable; audit is observability, not the commit.
  }
}

/**
 * Server-assigned registration seats: an unbiased CSPRNG Fisher-Yates
 * permutation of `0..count-1`. The roster array order never controls a seat.
 */
export function shuffledSeats(count: number): number[] {
  const seats = Array.from({ length: count }, (_, index) => index);
  for (let index = seats.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    const current = seats[index];
    seats[index] = seats[swap];
    seats[swap] = current;
  }
  return seats;
}

/**
 * Truthful cancellation projection from durable rows. A refund is reported only
 * when the entrant's durable REFUNDED state and exact refund journal exist; a
 * successful cancellation never reports a PAID entry.
 */
function buildCancellationResponse(competition: CompetitionRow): CancelCompetitionResponse {
  if (competition.status !== "CANCELLED" || competition.cancelledAt === null) {
    throw new AppError(
      "Competition cancellation is incomplete",
      409,
      "COMPETITION_CANCELLATION_INCOMPLETE"
    );
  }
  const prize =
    competition.mode === "ASSET" &&
    competition.prizeStatus === "RELEASED" &&
    competition.prizeAssetId !== null &&
    competition.prizeAmountAtomic !== null
      ? { assetId: competition.prizeAssetId, amountAtomic: competition.prizeAmountAtomic }
      : null;
  return {
    success: true as const,
    competitionId: competition.id,
    status: "CANCELLED" as const,
    cancelledAt: competition.cancelledAt.toISOString(),
    prizeStatus: competition.prizeStatus,
    prize,
    entries: competition.entrants.map((entrant) => ({
      principalId: entrant.principalId,
      kind: entrant.kind,
      entryState: entrant.entryState,
      refunded: entrant.entryState === "REFUNDED",
      refundJournalId: entrant.refundJournalId,
    })),
  };
}

const COMPETITION_INCLUDE = {
  entrants: { orderBy: { seat: "asc" as const } },
  tournament: { select: { tableId: true } },
};

async function loadCompetition(
  fastify: FastifyInstance,
  id: string
): Promise<(CompetitionRow & { tournament: { tableId: string } }) | null> {
  return fastify.prisma.competition.findUnique({
    where: { id },
    include: COMPETITION_INCLUDE,
  });
}

/**
 * Derive the public `settlementReady` flag from the authoritative backing
 * tournament director state. Never mutates and never exposes engine internals:
 * - FINISHED competitions are always settlement-ready;
 * - a RUNNING competition is ready only when exactly one entry is ACTIVE with
 *   chips while every other entry is a settled elimination (ELIMINATED/PAID),
 *   and every backing table sits at a completed-hand boundary. An in-flight
 *   hand or an unsettled all-in is never reported ready.
 */
async function deriveSettlementReady(
  fastify: FastifyInstance,
  competition: { status: CompetitionRow["status"]; tournamentId: string }
): Promise<boolean> {
  if (competition.status === "FINISHED") return true;
  if (competition.status !== "RUNNING") return false;

  const entries = await fastify.prisma.tournamentEntry.findMany({
    where: { tournamentId: competition.tournamentId },
    select: { userId: true, status: true },
  });
  const active = entries.filter((entry) => entry.status === "ACTIVE");
  if (active.length !== 1) return false;
  if (entries.some((entry) => entry.status === "REGISTERED")) return false;

  const tables = await fastify.prisma.table.findMany({
    where: { tournamentId: competition.tournamentId },
    select: { id: true },
  });
  if (tables.length === 0) return false;

  let winnerStack = 0;
  let sawWinner = false;
  for (const table of tables) {
    let state;
    try {
      state = await fastify.gameManager.getState(table.id);
    } catch {
      return false;
    }
    const settledBoundary =
      (state.handNumber === 0 && state.actionTo == null) ||
      Boolean(state.winners && state.winners.length > 0 && state.actionTo == null);
    if (!settledBoundary) return false;
    const player = state.players.find((candidate) => candidate?.id === active[0].userId);
    if (player) {
      winnerStack += player.stack;
      sawWinner = true;
    }
  }
  return sawWinner && winnerStack > 0;
}

export interface CreateCompetitionResult {
  competition: Competition;
  replayed: boolean;
}

/**
 * Provision a competition and its authoritative backing tournament/roster.
 *
 * Atomic admission: the backing table, its initial durable snapshot, the
 * tournament, the competition, the roster entries and the sponsor prize
 * reservation commit in ONE database transaction, so no table can be visible
 * without its managed metadata and no crash can orphan one. Idempotent on
 * `(organizerId, idempotencyKey)` with a request-hash conflict check, so a
 * retry after a failure or lost response can never create a second
 * competition.
 */
export async function createCompetition(
  fastify: FastifyInstance,
  input: { organizer: AuthenticatedPrincipal; request: CreateCompetitionRequest }
): Promise<CreateCompetitionResult> {
  const { organizer, request } = input;

  const startingStack = request.startingStack ?? 1000;
  const smallBlind = request.smallBlind ?? 10;
  const bigBlind = request.bigBlind ?? (request.smallBlind !== undefined ? smallBlind * 2 : 20);
  const blindStructure = defaultBlindStructure(smallBlind, bigBlind);
  const requestHash = fastify.idempotencyManager.hash(request);

  const existing = await fastify.prisma.competition.findUnique({
    where: {
      organizerId_idempotencyKey: {
        organizerId: organizer.id,
        idempotencyKey: request.idempotencyKey,
      },
    },
    include: COMPETITION_INCLUDE,
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        "Idempotency key was already used for a different request",
        409,
        "IDEMPOTENCY_CONFLICT"
      );
    }
    return {
      competition: toWireCompetition(
        existing,
        existing.tournament.tableId,
        await deriveSettlementReady(fastify, existing)
      ),
      replayed: true,
    };
  }

  if (request.mode === "ASSET") await assertPaidAdmissionReady(fastify);

  // Durable principal validation. The sponsor is usually a platform/HOUSE
  // account that is NOT on the roster, so it is resolved independently.
  const entrantIds = request.entrants.map((entrant) => entrant.principalId);
  const principalIds = new Set(entrantIds);
  if (request.mode === "ASSET" && request.terms) {
    principalIds.add(request.terms.prize.sponsorPrincipalId);
  }
  const principals = await fastify.prisma.user.findMany({
    where: { id: { in: [...principalIds] } },
    select: { id: true, kind: true },
  });
  const byId = new Map(principals.map((principal) => [principal.id, principal]));
  for (const entrant of request.entrants) {
    const durable = byId.get(entrant.principalId);
    if (!durable) {
      throw new AppError(
        `Unknown competition entrant ${entrant.principalId}`,
        400,
        "COMPETITION_ENTRANT_UNKNOWN"
      );
    }
    if (durable.kind !== entrant.kind) {
      throw new AppError(
        "Entrant kind does not match the durable principal",
        400,
        "COMPETITION_ENTRANT_KIND_MISMATCH"
      );
    }
  }

  // Owner-delegation guard for orchestration SERVICE principals: they may only
  // roster SERVICE principals an operator delegated to them.
  if (organizer.kind === "SERVICE" && !organizer.isOperator) {
    const serviceEntrantIds = request.entrants
      .filter((entrant) => entrant.kind === "SERVICE")
      .map((entrant) => entrant.principalId);
    if (serviceEntrantIds.length > 0) {
      const delegations = await fastify.prisma.servicePrincipalDelegation.findMany({
        where: {
          servicePrincipalId: { in: serviceEntrantIds },
          delegatePrincipalId: organizer.id,
          revokedAt: null,
        },
        select: { servicePrincipalId: true },
      });
      const delegated = new Set(delegations.map((row) => row.servicePrincipalId));
      if (serviceEntrantIds.some((id) => !delegated.has(id))) {
        throw new AppError(
          "SERVICE entrant is not delegated to this organizer",
          403,
          "COMPETITION_ENTRANT_NOT_DELEGATED"
        );
      }
    }
  }

  let sponsorId: string | null = null;
  let entryAssetId: string | null = null;
  let entryAmountAtomic: string | null = null;
  let prizeAssetId: string | null = null;
  let prizeAmountAtomic: string | null = null;
  const payerAmounts = new Map<string, string>();

  if (request.mode === "ASSET" && request.terms) {
    entryAssetId = request.terms.entry.assetId;
    entryAmountAtomic = request.terms.entry.amountAtomic;
    prizeAssetId = request.terms.prize.assetId;
    prizeAmountAtomic = request.terms.prize.amountAtomic;
    sponsorId = request.terms.prize.sponsorPrincipalId;

    const sponsor = byId.get(sponsorId);
    if (!sponsor) {
      throw new AppError("Unknown sponsor principal", 400, "COMPETITION_SPONSOR_UNKNOWN");
    }
    assertAuthorizedSponsor({ organizer, sponsorId, sponsorKind: sponsor.kind });

    // Pre-check outside the transaction for a fast, clear rejection; the
    // transaction re-asserts ACTIVE so a freeze race cannot admit value.
    const assets = await fastify.prisma.asset.findMany({
      where: { id: { in: [entryAssetId, prizeAssetId] } },
      select: { id: true, status: true },
    });
    const statusById = new Map(assets.map((asset) => [asset.id, asset.status]));
    if (statusById.get(entryAssetId) !== "ACTIVE") {
      throw new AppError("entry asset is not ACTIVE", 409, "COMPETITION_ASSET_NOT_ACTIVE");
    }
    if (statusById.get(prizeAssetId) !== "ACTIVE") {
      throw new AppError("prize asset is not ACTIVE", 409, "COMPETITION_ASSET_NOT_ACTIVE");
    }

    for (const payer of request.terms.entry.payers) {
      payerAmounts.set(payer.principalId, payer.amountAtomic ?? entryAmountAtomic);
    }
  }

  const engineMax = request.entrants.length;
  // Server CSPRNG Fisher-Yates seating: the roster array order never controls
  // any registration/engine seat. Assigned before the transaction so the same
  // permutation is inserted into both the competition roster and the backing
  // tournament entries.
  const seats = shuffledSeats(engineMax);
  let created: { competitionId: string; tableId: string; snapshot: unknown };
  try {
    created = await fastify.prisma.$transaction(
      async (tx) => {
        // Atomic admission: table + snapshot + tournament + competition +
        // roster + prize reservation share one transaction boundary.
        const { tableId, snapshot } = await fastify.gameManager.createTableInTx(tx, {
          name: request.name,
          mode: "TOURNAMENT",
          smallBlind,
          bigBlind,
          maxPlayers: engineMax,
          blindStructure,
          startingStack,
        });

        const tournament = await tx.tournament.create({
          data: {
            name: request.name,
            creatorId: organizer.id,
            tableId,
            buyIn: 0,
            fee: 0,
            startingStack,
            maxPlayers: engineMax,
            tableMaxPlayers: engineMax,
            balancingTolerance: 0,
            blindStructure: blindStructure as unknown as Prisma.InputJsonValue,
            payoutPercentages: [],
          },
          select: { id: true },
        });

        await tx.table.update({
          where: { id: tableId },
          data: { tournamentId: tournament.id, status: "WAITING" },
        });

        const competition = await tx.competition.create({
          data: {
            name: request.name,
            mode: request.mode,
            organizerId: organizer.id,
            tournamentId: tournament.id,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            startingStack,
            smallBlind,
            bigBlind,
            entryAssetId,
            entryAmountAtomic,
            prizeAssetId,
            prizeAmountAtomic,
            sponsorId,
            prizeStatus: request.mode === "ASSET" ? "RESERVED" : "NOT_APPLICABLE",
          },
          select: { id: true },
        });

        for (let index = 0; index < request.entrants.length; index++) {
          const entrant = request.entrants[index];
          const seat = seats[index];
          const entryAmount = payerAmounts.get(entrant.principalId) ?? null;
          await tx.competitionEntrant.create({
            data: {
              competitionId: competition.id,
              principalId: entrant.principalId,
              kind: entrant.kind,
              seat,
              entryState: entryAmount !== null ? "PENDING" : "NOT_REQUIRED",
              entryAmountAtomic: entryAmount,
            },
          });
          await tx.tournamentEntry.create({
            data: {
              tournamentId: tournament.id,
              userId: entrant.principalId,
              seat,
              status: "REGISTERED",
            },
          });
        }

        if (
          request.mode === "ASSET" &&
          sponsorId !== null &&
          prizeAssetId !== null &&
          prizeAmountAtomic !== null &&
          entryAssetId !== null
        ) {
          // Freeze race: lock and re-assert ACTIVE under the durable asset
          // lock (sorted order) inside the same transaction as the reserve.
          await fastify.financialManager.lockAndRequireActiveAssets(tx, [
            entryAssetId,
            prizeAssetId,
          ]);
          const reservation = await fastify.financialManager.applyCompetitionPrizeReserve(tx, {
            competitionId: competition.id,
            sponsorId,
            assetId: prizeAssetId,
            amountAtomic: prizeAmountAtomic,
          });
          await tx.competition.update({
            where: { id: competition.id },
            data: { prizeReservationJournalId: reservation.journalRequestId },
          });
        }

        return { competitionId: competition.id, tableId, snapshot };
      },
      { maxWait: 10_000, timeout: 15_000 }
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await fastify.prisma.competition.findUnique({
        where: {
          organizerId_idempotencyKey: {
            organizerId: organizer.id,
            idempotencyKey: request.idempotencyKey,
          },
        },
        include: COMPETITION_INCLUDE,
      });
      if (raced && raced.requestHash === requestHash) {
        return {
          competition: toWireCompetition(
            raced,
            raced.tournament.tableId,
            await deriveSettlementReady(fastify, raced)
          ),
          replayed: true,
        };
      }
      throw new AppError(
        "Idempotency key was already used for a different request",
        409,
        "IDEMPOTENCY_CONFLICT"
      );
    }
    if (error instanceof InsufficientFundsError) {
      throw new AppError(
        "Competition sponsor cannot fund the reserved prize",
        409,
        "COMPETITION_SPONSOR_UNFUNDED"
      );
    }
    throw error;
  }

  // Post-commit cache is best-effort; the database is authoritative.
  try {
    await fastify.redis.set(
      `table:${created.tableId}`,
      JSON.stringify(created.snapshot),
      "EX",
      config.TABLE_REDIS_TTL_SECONDS
    );
  } catch {
    // Redis is only a cache.
  }

  const row = await loadCompetition(fastify, created.competitionId);
  if (!row) throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");

  await recordAcceptedAudit(fastify, {
    actorId: organizer.id,
    action: "COMPETITION_CREATE",
    resource: `competition:${row.id}`,
    metadata: { mode: request.mode, entrants: request.entrants.length },
  });

  return {
    competition: toWireCompetition(
      row,
      row.tournament.tableId,
      await deriveSettlementReady(fastify, row)
    ),
    replayed: false,
  };
}

export async function getCompetition(fastify: FastifyInstance, id: string): Promise<Competition> {
  const competition = await loadCompetition(fastify, id);
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  return toWireCompetition(
    competition,
    competition.tournament.tableId,
    await deriveSettlementReady(fastify, competition)
  );
}

/**
 * Configured WALLET payer opt-in: charges the explicit entry exactly once into
 * the competition's own entry reserve (never the sponsor's account).
 *
 * Natural idempotency: the durable entry marker plus the exact reserve-credit
 * journal is the operation identity — there is no request idempotency key. The
 * accepted charge receipt is replayed for the authenticated payer before the
 * registration gate, so a lost response stays replayable after start and even
 * after a prestart cancellation (the live entry state is then `REFUNDED`, the
 * journal receipt stays immutable). The transaction locks the competition row,
 * re-reads status/entrant and re-checks REGISTRATION, so a concurrent start or
 * cancellation can never be followed by a charge (no pay-after-start /
 * pay-after-cancel).
 */
export async function optInCompetition(
  fastify: FastifyInstance,
  input: { competitionId: string; principalId: string }
): Promise<OptInCompetitionResponse> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { id: input.competitionId },
    include: { entrants: true },
  });
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  if (competition.mode !== "ASSET") {
    throw new AppError(
      "Nonfinancial competitions have no entry to opt in to",
      400,
      "COMPETITION_NOT_ASSET"
    );
  }
  const entrant = competition.entrants.find(
    (candidate) => candidate.principalId === input.principalId
  );
  if (!entrant) {
    throw new AppError("Principal is not a competition entrant", 403, "COMPETITION_NOT_ENTRANT");
  }
  if (entrant.kind !== "WALLET") {
    throw new AppError(
      "SERVICE entrants are zero-entry and can never be charged",
      403,
      "COMPETITION_SERVICE_ZERO_ENTRY"
    );
  }
  if (
    competition.entryAssetId === null ||
    competition.entryAmountAtomic === null ||
    competition.sponsorId === null
  ) {
    throw new AppError(
      "Competition entry terms are incomplete",
      409,
      "COMPETITION_TERMS_INCOMPLETE"
    );
  }
  const amountAtomic = entrant.entryAmountAtomic ?? competition.entryAmountAtomic;

  // Durable replay first: a committed charge is evidenced by its immutable
  // reserve-credit journal and stays replayable for this authenticated payer
  // after start and after a prestart cancellation.
  if (entrant.entryState === "PAID" || entrant.entryState === "REFUNDED") {
    if (entrant.entryJournalId === null) {
      throw new AppError(
        "Competition entry journal evidence is missing",
        409,
        "COMPETITION_ENTRY_EVIDENCE_MISSING"
      );
    }
    return {
      success: true,
      competitionId: competition.id,
      principalId: entrant.principalId,
      entryState: entrant.entryState,
      entry: { assetId: competition.entryAssetId, amountAtomic },
      journalRequestId: entrant.entryJournalId,
    };
  }
  if (entrant.entryState !== "PENDING") {
    throw new AppError(
      "Principal is not a configured entry payer",
      400,
      "COMPETITION_ENTRY_NOT_REQUIRED"
    );
  }
  if (competition.status !== "REGISTRATION") {
    throw new AppError("Competition registration is closed", 409, "COMPETITION_NOT_REGISTERING");
  }

  await assertPaidAdmissionReady(fastify);

  const journal = await fastify.prisma.$transaction(
    async (tx) => {
      await lockCompetitionRow(tx, competition.id);
      const fresh = await tx.competition.findUniqueOrThrow({
        where: { id: competition.id },
        select: {
          status: true,
          mode: true,
          entryAssetId: true,
          entryAmountAtomic: true,
          sponsorId: true,
        },
      });
      const freshEntrant = await tx.competitionEntrant.findUniqueOrThrow({
        where: {
          competitionId_principalId: {
            competitionId: competition.id,
            principalId: input.principalId,
          },
        },
      });
      // A concurrent opt-in may have committed while this transaction waited.
      if (freshEntrant.entryState === "PAID" || freshEntrant.entryState === "REFUNDED") {
        if (freshEntrant.entryJournalId === null) {
          throw new AppError(
            "Competition entry journal evidence is missing",
            409,
            "COMPETITION_ENTRY_EVIDENCE_MISSING"
          );
        }
        return { journalRequestId: freshEntrant.entryJournalId };
      }
      if (freshEntrant.entryState !== "PENDING") {
        throw new AppError(
          "Principal is not a configured entry payer",
          400,
          "COMPETITION_ENTRY_NOT_REQUIRED"
        );
      }
      // Serialized winner check: a start or cancellation committed before this
      // transaction took the row lock must prevent any charge.
      if (fresh.status !== "REGISTRATION") {
        throw new AppError(
          "Competition registration is closed",
          409,
          "COMPETITION_NOT_REGISTERING"
        );
      }
      if (
        fresh.mode !== "ASSET" ||
        fresh.entryAssetId === null ||
        fresh.entryAmountAtomic === null ||
        fresh.sponsorId === null
      ) {
        throw new AppError(
          "Competition entry terms are incomplete",
          409,
          "COMPETITION_TERMS_INCOMPLETE"
        );
      }
      const result = await fastify.financialManager.applyCompetitionEntry(tx, {
        competitionId: competition.id,
        payerId: freshEntrant.principalId,
        assetId: fresh.entryAssetId,
        amountAtomic: freshEntrant.entryAmountAtomic ?? fresh.entryAmountAtomic,
      });
      await tx.competitionEntrant.update({
        where: { id: freshEntrant.id },
        data: { entryState: "PAID", entryJournalId: result.journalRequestId },
      });
      return result;
    },
    { maxWait: 10_000, timeout: 15_000 }
  );

  // Report the live durable entry state at response time: a concurrent
  // cancellation may have refunded the just-committed charge. The journal
  // receipt is immutable either way.
  const live = await fastify.prisma.competitionEntrant.findUniqueOrThrow({
    where: {
      competitionId_principalId: {
        competitionId: competition.id,
        principalId: input.principalId,
      },
    },
    select: { entryState: true },
  });
  if (live.entryState !== "PAID" && live.entryState !== "REFUNDED") {
    throw new AppError(
      "Competition entry state is inconsistent",
      409,
      "COMPETITION_ENTRY_EVIDENCE_MISSING"
    );
  }

  await recordAcceptedAudit(fastify, {
    actorId: input.principalId,
    action: "COMPETITION_OPT_IN",
    resource: `competition:${input.competitionId}`,
    metadata: { journalRequestId: journal.journalRequestId },
  });

  return {
    success: true,
    competitionId: competition.id,
    principalId: entrant.principalId,
    entryState: live.entryState,
    entry: { assetId: competition.entryAssetId, amountAtomic },
    journalRequestId: journal.journalRequestId,
  };
}

/**
 * Start a fully provisioned competition.
 *
 * One transaction seats every entrant (engine SIT + entry assignment), flips
 * the tournament RUNNING, deals the first hand and flips the competition
 * RUNNING with `startedAt`; held entries are transferred to the sponsor exactly
 * once inside that same transaction. Until that commit, no seat or hand is
 * publicly observable and public actions are rejected by the game authority;
 * after it, every entrant is seated.
 *
 * Race safety: the transaction locks the competition row and re-reads status
 * and entries, so a concurrent cancellation can never be followed by a start
 * (`REGISTRATION -> RUNNING` / `REGISTRATION -> CANCELLED` have exactly one
 * winner). Unpaid entries are re-checked under the lock, so an opt-in that
 * commits after the lock is observed and blocks the start instead of racing it.
 *
 * Natural idempotency: a durable `startedAt` makes start replayable from
 * durable state — while RUNNING and after settlement — with no request
 * idempotency key. Paid admission is readiness-gated and re-asserts assets
 * ACTIVE inside the transaction.
 */
export async function startCompetition(
  fastify: FastifyInstance,
  input: { competitionId: string; actor: AuthenticatedPrincipal }
): Promise<StartCompetitionResponse> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { id: input.competitionId },
    include: { entrants: { orderBy: { seat: "asc" } }, tournament: true },
  });
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  assertCompetitionOwner(input.actor, competition);

  const seatsFor = (entrants: Array<{ principalId: string; seat: number }>) =>
    entrants.map((entrant) => ({ principalId: entrant.principalId, seat: entrant.seat }));

  if (competition.startedAt !== null) {
    // Durable start replay: the accepted start stays valid while RUNNING and
    // after settlement; a CANCELLED competition never has a start marker.
    return {
      success: true as const,
      competitionId: competition.id,
      tableId: competition.tournament.tableId,
      seats: seatsFor(competition.entrants),
    };
  }
  if (competition.status !== "REGISTRATION") {
    throw new AppError("Competition is not accepting a start", 409, "COMPETITION_NOT_REGISTERING");
  }
  if (competition.entrants.length < 2) {
    throw new AppError(
      "Competition requires at least two entrants",
      400,
      "COMPETITION_REQUIRES_TWO_ENTRANTS"
    );
  }
  if (competition.mode === "ASSET") {
    const unpaid = competition.entrants.filter((entrant) => entrant.entryState === "PENDING");
    if (unpaid.length > 0) {
      throw new AppError(
        "Configured entry payers must opt in before start",
        409,
        "COMPETITION_ENTRY_UNPAID"
      );
    }
    if (competition.prizeStatus !== "RESERVED" || competition.prizeReservationJournalId === null) {
      throw new AppError("Sponsor prize is not reserved", 503, "COMPETITION_PRIZE_NOT_RESERVED");
    }
    await assertPaidAdmissionReady(fastify);
  }

  const tableId = competition.tournament.tableId;
  const now = new Date();
  await fastify.prisma.$transaction(
    async (tx) => {
      await lockCompetitionRow(tx, competition.id);
      const fresh = await tx.competition.findUniqueOrThrow({
        where: { id: competition.id },
        include: { entrants: { orderBy: { seat: "asc" } } },
      });
      if (fresh.startedAt !== null) {
        // A concurrent start committed while this transaction waited.
        return;
      }
      if (fresh.status !== "REGISTRATION") {
        throw new AppError(
          "Competition is not accepting a start",
          409,
          "COMPETITION_NOT_REGISTERING"
        );
      }
      if (fresh.entrants.length < 2) {
        throw new AppError(
          "Competition requires at least two entrants",
          400,
          "COMPETITION_REQUIRES_TWO_ENTRANTS"
        );
      }
      if (fresh.mode === "ASSET") {
        if (fresh.entryAssetId === null || fresh.prizeAssetId === null) {
          throw new AppError(
            "Competition asset terms are incomplete",
            409,
            "COMPETITION_TERMS_INCOMPLETE"
          );
        }
        // Freeze race: lock and re-assert ACTIVE under the durable asset lock
        // (sorted order) before any release, seat, deal or RUNNING transition.
        await fastify.financialManager.lockAndRequireActiveAssets(tx, [
          fresh.entryAssetId,
          fresh.prizeAssetId,
        ]);
        if (fresh.prizeStatus !== "RESERVED" || fresh.prizeReservationJournalId === null) {
          throw new AppError(
            "Sponsor prize is not reserved",
            503,
            "COMPETITION_PRIZE_NOT_RESERVED"
          );
        }
        // Re-check entry obligations under the row lock: a concurrent opt-in
        // either committed before this lock (and is released below) or is
        // blocked behind it, so a start can never race an unpaid entry.
        if (fresh.entrants.some((entrant) => entrant.entryState === "PENDING")) {
          throw new AppError(
            "Configured entry payers must opt in before start",
            409,
            "COMPETITION_ENTRY_UNPAID"
          );
        }
        for (const entrant of fresh.entrants) {
          if (entrant.entryState !== "PAID") continue;
          if (entrant.entryJournalId === null) {
            throw new AppError(
              "Competition entry value cannot be accounted for",
              409,
              "COMPETITION_ENTRY_EVIDENCE_MISSING"
            );
          }
          // Canonical evidence only: the exact reserve-credit journal.
          await fastify.financialManager.assertCompetitionEntryHeld(tx, {
            competitionId: fresh.id,
            journalRequestId: entrant.entryJournalId,
          });
          const amountAtomic = entrant.entryAmountAtomic ?? fresh.entryAmountAtomic;
          if (amountAtomic === null) {
            throw new AppError(
              "Competition entry amount is missing",
              409,
              "COMPETITION_TERMS_INCOMPLETE"
            );
          }
          const release = await fastify.financialManager.applyCompetitionEntryRelease(tx, {
            competitionId: fresh.id,
            payerId: entrant.principalId,
            sponsorId: fresh.sponsorId!,
            assetId: fresh.entryAssetId,
            amountAtomic,
          });
          await tx.competitionEntrant.update({
            where: { id: entrant.id },
            data: { entrySettlementJournalId: release.journalRequestId },
          });
        }
      }

      await tx.tournament.update({
        where: { id: fresh.tournamentId },
        data: { status: "RUNNING", startedAt: now, lastBlindAdvancedAt: now },
      });
      await tx.tournamentEntry.updateMany({
        where: { tournamentId: fresh.tournamentId, status: "REGISTERED" },
        data: { status: "ACTIVE" },
      });
      await tx.table.update({ where: { id: tableId }, data: { status: "ACTIVE" } });

      const users = await tx.user.findMany({
        where: { id: { in: fresh.entrants.map((entrant) => entrant.principalId) } },
        select: { id: true, username: true },
      });
      const usernameById = new Map(users.map((user) => [user.id, user.username]));

      // Seat every entrant before the competition becomes publicly actionable.
      for (const entrant of fresh.entrants) {
        await fastify.gameManager.applyManagementMutationInTx(
          tx,
          tableId,
          input.actor.id,
          {
            type: ActionType.SIT,
            playerId: entrant.principalId,
            playerName: usernameById.get(entrant.principalId) ?? entrant.principalId,
            seat: entrant.seat,
            stack: fresh.startingStack,
          },
          { skipIdentity: true }
        );
        await tx.tournamentEntry.update({
          where: {
            tournamentId_userId: {
              tournamentId: fresh.tournamentId,
              userId: entrant.principalId,
            },
          },
          data: { currentTableId: tableId, currentSeat: entrant.seat },
        });
      }

      // Deal only after every seat is durable, still inside the same commit.
      await fastify.gameManager.applyManagementMutationInTx(
        tx,
        tableId,
        input.actor.id,
        { type: ActionType.DEAL },
        { skipIdentity: true }
      );

      await tx.competition.update({
        where: { id: fresh.id },
        data: { status: "RUNNING", startedAt: now },
      });

      await recordTournamentEvent(tx, {
        tournamentId: fresh.tournamentId,
        type: "TOURNAMENT_STARTED",
        payload: {
          competitionId: fresh.id,
          tableId,
          seats: fresh.entrants.map((entrant) => ({
            principalId: entrant.principalId,
            seat: entrant.seat,
          })),
        },
        stateFingerprint: `competition-started:${fresh.id}`,
        requestRef: input.actor.id,
      });
    },
    { maxWait: 10_000, timeout: 15_000 }
  );

  await fastify.gameManager.publishCommitted(tableId).catch(() => undefined);
  await recordAcceptedAudit(fastify, {
    actorId: input.actor.id,
    action: "COMPETITION_START",
    resource: `competition:${competition.id}`,
  });

  return {
    success: true as const,
    competitionId: competition.id,
    tableId,
    seats: seatsFor(competition.entrants),
  };
}

/**
 * Settle a running competition through the shared tournament lifecycle and
 * dispose of the reserved prize exactly once. Settlement is risk-reducing and
 * intentionally not readiness-gated: a provider outage must never trap a
 * reserved prize or block releasing value.
 */
export async function settleCompetition(
  fastify: FastifyInstance,
  input: { competitionId: string; actor: AuthenticatedPrincipal }
): Promise<SettleCompetitionResponse> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { id: input.competitionId },
    include: { entrants: true },
  });
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  assertCompetitionOwner(input.actor, competition);

  let entries = await fastify.prisma.tournamentEntry.findMany({
    where: { tournamentId: competition.tournamentId },
    orderBy: { placement: "asc" },
  });
  const kindByPrincipal = new Map(
    competition.entrants.map((entrant) => [entrant.principalId, entrant.kind])
  );

  const buildResult = (
    prizeStatus: CompetitionPrizeStatus,
    prizeAmountAtomic: string | null
  ): SettleCompetitionResponse => {
    const winnerEntry = entries.find((entry) => entry.placement === 1);
    if (!winnerEntry) {
      throw new AppError(
        "Competition has no authoritative winner",
        409,
        "COMPETITION_SETTLEMENT_INCOMPLETE"
      );
    }
    const winnerKind = kindByPrincipal.get(winnerEntry.userId);
    if (winnerKind !== "WALLET" && winnerKind !== "SERVICE") {
      throw new AppError(
        "Competition winner has no durable entrant kind",
        409,
        "COMPETITION_SETTLEMENT_INCOMPLETE"
      );
    }
    const placements: CompetitionPlacement[] = entries
      .filter((entry) => entry.placement !== null)
      .map((entry) => {
        const kind = kindByPrincipal.get(entry.userId);
        if (kind !== "WALLET" && kind !== "SERVICE") {
          throw new AppError(
            "Competition placement has no durable entrant kind",
            409,
            "COMPETITION_SETTLEMENT_INCOMPLETE"
          );
        }
        return {
          principalId: entry.userId,
          kind,
          placement: entry.placement ?? 0,
          prize:
            entry.placement === 1 && prizeAmountAtomic !== null
              ? { assetId: competition.prizeAssetId!, amountAtomic: prizeAmountAtomic }
              : null,
        };
      });
    return {
      success: true as const,
      competitionId: competition.id,
      winnerPrincipalId: winnerEntry.userId,
      winnerKind,
      prizeStatus,
      prize:
        prizeAmountAtomic !== null && competition.prizeAssetId !== null
          ? { assetId: competition.prizeAssetId, amountAtomic: prizeAmountAtomic }
          : null,
      placements,
    };
  };

  // Fully settled already: replay the accepted result without moving value.
  if (competition.status === "FINISHED") {
    const prizePaid = competition.prizeStatus === "PAID" && competition.prizeAmountAtomic !== null;
    return buildResult(competition.prizeStatus, prizePaid ? competition.prizeAmountAtomic : null);
  }
  if (competition.status !== "RUNNING") {
    throw new AppError("Competition is not running", 409, "COMPETITION_NOT_RUNNING");
  }

  const settled = await settleTournament(fastify, competition.tournamentId, input.actor.id);
  // Settlement assigns authoritative placements; reload them before deciding.
  entries = await fastify.prisma.tournamentEntry.findMany({
    where: { tournamentId: competition.tournamentId },
    orderBy: { placement: "asc" },
  });
  // Durable winner identity: the authoritative placement, independent of prize
  // amounts. A live settlement result that disagrees fails closed rather than
  // flipping the disposition.
  const placementWinnerId = entries.find((entry) => entry.placement === 1)?.userId ?? null;
  if (!placementWinnerId) {
    throw new AppError(
      "Competition has no authoritative winner",
      409,
      "COMPETITION_SETTLEMENT_INCOMPLETE"
    );
  }
  if (settled.winnerUserId && settled.winnerUserId !== placementWinnerId) {
    throw new AppError(
      "Competition settlement winner diverged from the authoritative placement",
      409,
      "COMPETITION_SETTLEMENT_DIVERGENT"
    );
  }

  const disposition = await fastify.prisma.$transaction(async (tx) => {
    // Serialize the durable disposition decision on the competition row. Under
    // READ COMMITTED two invocations would otherwise branch on stale
    // status/prizeStatus snapshots and could apply different dispositions.
    await lockCompetitionRow(tx, competition.id);
    const fresh = await tx.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: {
        status: true,
        mode: true,
        prizeStatus: true,
        prizeSettlementJournalId: true,
        prizeAssetId: true,
        prizeAmountAtomic: true,
        sponsorId: true,
      },
    });
    if (fresh.status === "FINISHED") {
      // Another invocation decided durably: replay its decision.
      return { prizeStatus: fresh.prizeStatus };
    }

    // Winner identity and kind are read inside the same transaction from
    // durable rows; there is no default that could flip the disposition.
    const txEntries = await tx.tournamentEntry.findMany({
      where: { tournamentId: competition.tournamentId },
      orderBy: { placement: "asc" },
    });
    const txWinner = txEntries.find((entry) => entry.placement === 1);
    if (!txWinner || txWinner.userId !== placementWinnerId) {
      throw new AppError(
        "Competition settlement winner diverged from the authoritative placement",
        409,
        "COMPETITION_SETTLEMENT_DIVERGENT"
      );
    }
    const entrant = await tx.competitionEntrant.findUnique({
      where: {
        competitionId_principalId: {
          competitionId: competition.id,
          principalId: txWinner.userId,
        },
      },
      select: { kind: true },
    });
    const winnerKind = entrant?.kind;
    if (winnerKind !== "WALLET" && winnerKind !== "SERVICE") {
      throw new AppError(
        "Competition winner has no durable entrant kind",
        409,
        "COMPETITION_SETTLEMENT_INCOMPLETE"
      );
    }

    let prizeStatus: CompetitionPrizeStatus;
    let settlementJournalId = fresh.prizeSettlementJournalId;

    if (fresh.mode === "NONFINANCIAL") {
      prizeStatus = "NOT_APPLICABLE";
    } else {
      if (fresh.prizeStatus !== "RESERVED") {
        // A concurrent invocation already applied the single disposition.
        return { prizeStatus: fresh.prizeStatus };
      }
      if (fresh.prizeAssetId === null || fresh.prizeAmountAtomic === null) {
        throw new AppError(
          "Competition prize terms are incomplete",
          409,
          "COMPETITION_TERMS_INCOMPLETE"
        );
      }
      if (winnerKind === "WALLET") {
        const payout = await fastify.financialManager.applyCompetitionPrizePayout(tx, {
          competitionId: competition.id,
          winnerId: txWinner.userId,
          assetId: fresh.prizeAssetId,
          amountAtomic: fresh.prizeAmountAtomic,
        });
        prizeStatus = "PAID";
        settlementJournalId = payout.journalRequestId;
      } else {
        if (fresh.sponsorId === null) {
          throw new AppError("Competition sponsor is missing", 409, "COMPETITION_TERMS_INCOMPLETE");
        }
        const release = await fastify.financialManager.applyCompetitionPrizeRelease(tx, {
          competitionId: competition.id,
          sponsorId: fresh.sponsorId,
          assetId: fresh.prizeAssetId,
          amountAtomic: fresh.prizeAmountAtomic,
        });
        prizeStatus = "RELEASED";
        settlementJournalId = release.journalRequestId;
      }
    }

    await tx.competition.update({
      where: { id: competition.id },
      data: {
        status: "FINISHED",
        finishedAt: new Date(),
        prizeStatus,
        prizeSettlementJournalId: settlementJournalId,
      },
    });

    return { prizeStatus };
  });

  // A concurrent invocation may have completed while this one waited on the
  // row lock; project the accepted durable result.
  entries = await fastify.prisma.tournamentEntry.findMany({
    where: { tournamentId: competition.tournamentId },
    orderBy: { placement: "asc" },
  });

  await recordAcceptedAudit(fastify, {
    actorId: input.actor.id,
    action: "COMPETITION_SETTLE",
    resource: `competition:${input.competitionId}`,
    metadata: { prizeStatus: disposition.prizeStatus },
  });

  const prizePaid = disposition.prizeStatus === "PAID" && competition.prizeAmountAtomic !== null;
  return buildResult(disposition.prizeStatus, prizePaid ? competition.prizeAmountAtomic : null);
}

/**
 * Cancel a competition before it starts.
 *
 * One transaction: refunds every PAID entry still held in the competition's own
 * entry reserve, releases the reserved prize to the sponsor, marks the backing
 * tournament CANCELLED and closes its table, then flips the competition
 * CANCELLED with `cancelledAt`. It deliberately does **not** require financial
 * readiness or ACTIVE assets: cancellation is risk-reducing and must work under
 * frozen/degraded admission conditions.
 *
 * Race safety: the transaction locks the competition row and re-reads state, so
 * `REGISTRATION -> RUNNING` and `REGISTRATION -> CANCELLED` have exactly one
 * winner; a losing start/cancel reports the winner's durable state. Concurrent
 * opt-ins are serialized behind the same lock and can never pay after
 * cancellation.
 *
 * All-or-nothing: every PAID entry must be evidenced by its exact
 * reserve-credit journal. If any paid value cannot be accounted for (missing,
 * unsealed or foreign journal), the whole cancellation is refused with 409
 * `COMPETITION_ENTRY_UNRESOLVED` and the competition stays REGISTRATION — no
 * partial refund, no false cancellation, no transfer from a non-canonical
 * account.
 *
 * Natural idempotency: an accepted cancellation replays from durable state
 * (`status`, `cancelledAt`, entrant REFUNDED markers and exact refund
 * journals). The response never reports an entry as refunded unless the exact
 * refund journal exists.
 */
export async function cancelCompetition(
  fastify: FastifyInstance,
  input: { competitionId: string; actor: AuthenticatedPrincipal }
): Promise<CancelCompetitionResponse> {
  const competition = await loadCompetition(fastify, input.competitionId);
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  assertCompetitionOwner(input.actor, competition);

  if (competition.status === "CANCELLED") {
    // Durable replay: project the accepted cancellation without moving value.
    return buildCancellationResponse(competition);
  }
  if (competition.status !== "REGISTRATION") {
    throw new AppError(
      "Only a competition in registration can be cancelled",
      409,
      "COMPETITION_NOT_CANCELLABLE"
    );
  }

  const now = new Date();
  await fastify.prisma.$transaction(
    async (tx) => {
      await lockCompetitionRow(tx, competition.id);
      const fresh = await tx.competition.findUniqueOrThrow({
        where: { id: competition.id },
        include: {
          entrants: { orderBy: { seat: "asc" } },
          tournament: { select: { tableId: true } },
        },
      });
      if (fresh.status === "CANCELLED") {
        // A concurrent cancellation won while this transaction waited.
        return;
      }
      if (fresh.status !== "REGISTRATION") {
        throw new AppError(
          "Only a competition in registration can be cancelled",
          409,
          "COMPETITION_NOT_CANCELLABLE"
        );
      }

      // Refund exactly the entries held in this competition's reserve. Every
      // PAID entry must be evidenced by its exact reserve-credit journal; a
      // malformed or foreign journal blocks the entire cancellation with the
      // competition left in REGISTRATION — no partial refunds, no false
      // cancellation, no transfer from a non-canonical account.
      const refundedEntries: Array<{
        principalId: string;
        refundJournalId: string;
      }> = [];
      for (const entrant of fresh.entrants) {
        if (entrant.entryState !== "PAID") continue;
        if (entrant.entryJournalId === null || fresh.entryAssetId === null) {
          throw new AppError(
            "Competition entry value cannot be accounted for",
            409,
            "COMPETITION_ENTRY_UNRESOLVED"
          );
        }
        await fastify.financialManager.assertCompetitionEntryHeld(tx, {
          competitionId: fresh.id,
          journalRequestId: entrant.entryJournalId,
        });
        const amountAtomic = entrant.entryAmountAtomic ?? fresh.entryAmountAtomic;
        if (amountAtomic === null) {
          throw new AppError(
            "Competition entry amount is missing",
            409,
            "COMPETITION_TERMS_INCOMPLETE"
          );
        }
        const refund = await fastify.financialManager.applyCompetitionEntryRefund(tx, {
          competitionId: fresh.id,
          payerId: entrant.principalId,
          assetId: fresh.entryAssetId,
          amountAtomic,
        });
        await tx.competitionEntrant.update({
          where: { id: entrant.id },
          data: { entryState: "REFUNDED", refundJournalId: refund.journalRequestId },
        });
        refundedEntries.push({
          principalId: entrant.principalId,
          refundJournalId: refund.journalRequestId,
        });
      }

      let prizeStatus: CompetitionPrizeStatus = fresh.prizeStatus;
      if (fresh.mode === "ASSET" && fresh.prizeStatus === "RESERVED") {
        if (
          fresh.prizeAssetId === null ||
          fresh.prizeAmountAtomic === null ||
          fresh.sponsorId === null
        ) {
          throw new AppError(
            "Competition prize terms are incomplete",
            409,
            "COMPETITION_TERMS_INCOMPLETE"
          );
        }
        // Risk-reducing: release without an ACTIVE-asset or readiness gate.
        await fastify.financialManager.applyCompetitionPrizeRelease(tx, {
          competitionId: fresh.id,
          sponsorId: fresh.sponsorId,
          assetId: fresh.prizeAssetId,
          amountAtomic: fresh.prizeAmountAtomic,
        });
        prizeStatus = "RELEASED";
      }

      await tx.tournament.update({
        where: { id: fresh.tournamentId },
        data: { status: "CANCELLED", finishedAt: now },
      });
      await tx.table.update({
        where: { id: fresh.tournament.tableId },
        data: { status: "CLOSED" },
      });
      await tx.competition.update({
        where: { id: fresh.id },
        data: { status: "CANCELLED", cancelledAt: now, prizeStatus },
      });

      await recordTournamentEvent(tx, {
        tournamentId: fresh.tournamentId,
        type: "TOURNAMENT_CANCELLED",
        payload: {
          competitionId: fresh.id,
          tableId: fresh.tournament.tableId,
          refundedEntries,
          prizeStatus,
        },
        stateFingerprint: `competition-cancelled:${fresh.id}`,
        requestRef: input.actor.id,
      });
    },
    { maxWait: 10_000, timeout: 15_000 }
  );

  // Best-effort cache eviction; the database is authoritative.
  try {
    await fastify.redis.del(`table:${competition.tournament.tableId}`);
  } catch {
    // Redis is only a cache.
  }

  await recordAcceptedAudit(fastify, {
    actorId: input.actor.id,
    action: "COMPETITION_CANCEL",
    resource: `competition:${input.competitionId}`,
  });

  const row = await loadCompetition(fastify, input.competitionId);
  if (!row) throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  return buildCancellationResponse(row);
}

/**
 * Director reconciliation for a running competition. Delegates to the
 * authoritative tournament director (eliminations, placements, table close) so
 * competition play cannot drift from tournament rules.
 */
export async function reconcileCompetition(
  fastify: FastifyInstance,
  input: { competitionId: string; actor: AuthenticatedPrincipal }
): Promise<{ success: true }> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { id: input.competitionId },
  });
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  assertCompetitionOwner(input.actor, competition);
  if (competition.status !== "RUNNING") {
    throw new AppError("Competition is not running", 409, "COMPETITION_NOT_RUNNING");
  }
  await reconcileTournament(fastify, competition.tournamentId, input.actor.id);
  return { success: true };
}

/**
 * Issue or rotate a table-scoped agent credential for a delegated SERVICE
 * entrant of this competition. The credential can never carry orchestration,
 * operator or finance authority.
 */
export async function issueAgentCredential(
  fastify: FastifyInstance,
  input: {
    competitionId: string;
    actor: AuthenticatedPrincipal;
    principalId: string;
    name: string;
    scopes?: Array<"table:observe" | "table:act" | "table:chat">;
    seat?: number;
    expiresAt?: string;
    credentialId?: string;
  }
): Promise<IssuedAgentCredential> {
  const competition = await fastify.prisma.competition.findUnique({
    where: { id: input.competitionId },
    include: { entrants: true, tournament: true },
  });
  if (!competition) {
    throw new AppError("Competition not found", 404, "COMPETITION_NOT_FOUND");
  }
  assertCompetitionOwner(input.actor, competition);

  const entrant = competition.entrants.find(
    (candidate) => candidate.principalId === input.principalId
  );
  if (!entrant) {
    throw new AppError("Principal is not a competition entrant", 403, "COMPETITION_NOT_ENTRANT");
  }
  if (entrant.kind !== "SERVICE") {
    throw new AppError(
      "Agent credentials are only issued for SERVICE entrants",
      400,
      "COMPETITION_AGENT_CREDENTIAL_WALLET"
    );
  }
  // A requested seat must be the entrant's authoritative seat. Omitted seats
  // yield a table-only restriction, which stays valid for cached idempotent
  // receipts after the principal is eliminated and its engine seat is gone.
  if (input.seat !== undefined && input.seat !== entrant.seat) {
    throw new AppError(
      "Requested seat does not match the entrant's authoritative seat",
      400,
      "COMPETITION_AGENT_CREDENTIAL_SEAT_MISMATCH"
    );
  }
  if (input.actor.kind === "SERVICE") {
    const delegated = await fastify.principalManager.isServicePrincipalDelegatedTo(
      entrant.principalId,
      input.actor.id
    );
    if (!delegated) {
      throw new AppError(
        "SERVICE entrant is not delegated to this organizer",
        403,
        "COMPETITION_ENTRANT_NOT_DELEGATED"
      );
    }
  }

  // Rotation never broadens implicitly: when `scopes` is omitted on a rotate,
  // preserve the existing credential's scopes instead of substituting the
  // default set. A fresh issue (or an invalid rotation) falls back to the
  // canonical default; the principal manager still validates the credential.
  let scopes = input.scopes;
  if (scopes === undefined && input.credentialId !== undefined) {
    const existing = await fastify.prisma.serviceCredential.findUnique({
      where: { id: input.credentialId },
      select: { userId: true, tableId: true, scopes: true },
    });
    if (
      existing &&
      existing.userId === entrant.principalId &&
      existing.tableId === competition.tournament.tableId
    ) {
      const preserved = (Array.isArray(existing.scopes) ? existing.scopes : []).filter(
        (scope): scope is "table:observe" | "table:act" | "table:chat" =>
          scope === "table:observe" || scope === "table:act" || scope === "table:chat"
      );
      if (preserved.length > 0) scopes = preserved;
    }
  }

  const created = await fastify.principalManager.issueScopedCredential({
    principalId: entrant.principalId,
    tableId: competition.tournament.tableId,
    name: input.name,
    scopes: scopes ?? ["table:observe", "table:act", "table:chat"],
    seat: input.seat ?? null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    credentialId: input.credentialId ?? null,
    createdById: input.actor.id,
    audit: {
      actorId: input.actor.id,
      metadata: { competitionId: competition.id },
    },
  });

  return {
    credentialId: created.id,
    principalId: created.userId,
    competitionId: competition.id,
    tableId: created.tableId ?? competition.tournament.tableId,
    name: created.name,
    scopes: created.scopes.filter(
      (scope): scope is "table:observe" | "table:act" | "table:chat" =>
        scope !== "competition:orchestrate"
    ),
    seat: created.seat,
    expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
    token: created.token,
    rotated: input.credentialId !== undefined,
  };
}
