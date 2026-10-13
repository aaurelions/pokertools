import type { FastifyInstance } from "fastify";
import { randomInt } from "node:crypto";
import type { Prisma } from "../../generated/prisma/index.js";
import type {
  CancelCompetitionResponse,
  Competition,
  CompetitionEntrant,
  CompetitionPrizeStatus,
} from "@pokertools/types";
import { AppError } from "../utils/errors.js";
import { competitionSponsorPrincipalIds, config } from "../config.js";
import type { AuthenticatedPrincipal } from "./principal-manager.js";

/** Pure/shared helpers extracted from competition-manager (no logic changes). */

export interface CompetitionRow {
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
export async function assertPaidAdmissionReady(fastify: FastifyInstance): Promise<void> {
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

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

export function isPostgresDatabase(): boolean {
  return (config.DATABASE_URL ?? "").startsWith("postgres");
}

/**
 * Serialize lifecycle transitions for one competition on its durable row.
 * PostgreSQL takes an explicit row lock; SQLite serializes writers at the
 * database level. Every caller MUST re-read and re-check state after this.
 */
export async function lockCompetitionRow(
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
export async function recordAcceptedAudit(
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
export function buildCancellationResponse(competition: CompetitionRow): CancelCompetitionResponse {
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

export const COMPETITION_INCLUDE = {
  entrants: { orderBy: { seat: "asc" as const } },
  tournament: { select: { tableId: true } },
};

export async function loadCompetition(
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
export async function deriveSettlementReady(
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
