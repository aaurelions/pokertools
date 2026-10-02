import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { JobQueues } from "../plugins/queue.js";
import { PokerEngine, type Action, type GameState, type PublicState } from "@pokertools/engine";
import {
  CanonicalActionRequestSchema,
  CanonicalActionResultSchema,
  toPublicWireState,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type ChatMessage,
  type LegalAction,
  type PublicWireState,
  type ReplayFrame,
  type ReplayFrameEvent,
  type SeatObservation,
} from "@pokertools/types";
import { config as appConfig } from "../config.js";
import { NotFoundError } from "../utils/errors.js";
import { defaultBlindStructure } from "../utils/tournaments.js";
import {
  GameAuthorityError,
  canonicalActionHash,
  compareAndSetState,
  completeActionRequest,
  createActionRequest,
  deriveTurnId,
  findActionRequest,
  insertGameEvents,
  legalFamilyToEngineAction,
  loadAuthoritativeTable,
  sealEvents,
  type Snapshot,
} from "./game-repository.js";
import {
  buildActionEvent,
  buildChatEvent,
  buildHandCompletedEvent,
  buildHandStartedEvent,
  buildTableCreatedEvent,
  verifyEventChain,
  type PendingGameEvent,
} from "./game-events.js";
import { listTournamentEvents } from "./tournament-events.js";
import { dispatchPendingOutbox, writeOutboxIntents, type OutboxIntent } from "./game-outbox.js";
import { getLegalActions } from "./legal-actions.js";

export interface ProcessActionOptions {
  skipLock?: boolean;
  skipIdentity?: boolean;
  expectedVersion?: number;
}

/**
 * Canonical action result ({ receipt, observation }) — the shared
 * `@pokertools/types` contract. The full deterministic resulting observation is
 * persisted with the receipt in the idempotency row; an identical duplicate
 * with the same actor and complete payload returns that exact stored result.
 */
export type { SeatObservation } from "@pokertools/types";

/**
 * Public chat view. The shared strict `ChatMessage` contract (including the
 * authoritative `handId` at append time) is the single wire shape.
 */
export type ChatMessageView = ChatMessage;

/**
 * Ordered public replay frame. The shared strict `ReplayFrame` contract is the
 * single wire shape; it carries the hash-chain provenance (`previousHash`/
 * `hash`/`anchorHash`), the `headEventSeq` bound and the `chainValid` integrity
 * flag, plus any associated canonical tournament transitions/settlement refs.
 */
export type ReplayFrameView = ReplayFrame;

interface MutationInput {
  tableId: string;
  principalId: string;
  expectedVersion?: number;
  canonical: boolean;
  skipIdentity?: boolean;
  action?: Action;
  requestId?: string;
  turnId?: string;
  actionId?: string;
  amount?: number;
  requestHash?: string;
  /**
   * Optional extra invariant evaluated against the authoritative snapshot read
   * inside the CAS transaction, before the engine acts. Throwing rolls back the
   * whole transaction (including any caller-side financial mutation).
   */
  validateSnapshot?: (snapshot: Snapshot) => void;
}

type MutationTxResult =
  | { kind: "applied"; result: CanonicalActionResult }
  | { kind: "replay"; result: CanonicalActionResult }
  | { kind: "noop"; state: PublicWireState; version: number };

/** Result of an internal management mutation applied inside a caller transaction. */
export interface ManagementMutationResult {
  applied: boolean;
  state: PublicWireState;
  version: number;
  eventSeq: number | null;
}

export interface ManagementMutationOptions {
  expectedVersion?: number;
  skipIdentity?: boolean;
}

/**
 * Game Manager — orchestrates the poker engine with durable persistence.
 *
 * PostgreSQL is the sole authority for game mutations: every applied action is
 * a compare-and-set on `Table.stateVersion` + `Table.eventSeq` that writes the
 * snapshot, ordered public events, idempotency record and outbox intents in one
 * transaction. Redis is a best-effort cache/pubsub/lock layer only.
 */
export class GameManager {
  constructor(
    private redis: Redis,
    private redlock: Redlock,
    private queues: JobQueues,
    private prisma: PrismaClient
  ) {}

  /**
   * Internal management/worker mutation path (SIT, STAND, ADD_CHIPS, DEAL,
   * TIMEOUT). Public gameplay is submitted through `submitCanonicalAction`;
   * this remains for internal server management and scheduled workers and still
   * uses the same DB-authoritative CAS transaction.
   */
  async processAction(
    tableId: string,
    action: Action,
    userId: string,
    options: ProcessActionOptions = {}
  ): Promise<PublicWireState> {
    if (
      !options.skipIdentity &&
      "playerId" in action &&
      action.playerId !== userId &&
      action.type !== "TIMEOUT"
    ) {
      throw new GameAuthorityError(
        "IDENTITY_MISMATCH",
        "Identity mismatch: Cannot act for another player",
        403
      );
    }

    // Public/worker mutations on a competition-managed table are only legal
    // while the competition is RUNNING and fully seated. Director/management
    // mutations (skipIdentity) are exempt.
    if (!options.skipIdentity) await this.assertCompetitionActionable(tableId);

    const result = await this.runMutationWithLock(
      {
        tableId,
        action,
        principalId: userId || "",
        expectedVersion: options.expectedVersion,
        canonical: false,
        skipIdentity: options.skipIdentity,
      },
      options.skipLock,
      "throw"
    );
    if (result.kind === "noop") return result.state;
    return result.result.observation.state;
  }

  /**
   * Canonical gameplay submission. The actor is derived from auth
   * (principalId); the request only carries ids and an optional chip amount.
   */
  async submitCanonicalAction(
    tableId: string,
    principalId: string,
    request: CanonicalActionRequest
  ): Promise<CanonicalActionResult & { replayed: boolean }> {
    const parsed = CanonicalActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new GameAuthorityError(
        "INVALID_CANONICAL_ACTION",
        "Invalid canonical action request",
        400
      );
    }
    // Competition-managed tables are only actionable while RUNNING and fully
    // seated; settled/cancelled/partial states fail closed before any mutation.
    await this.assertCompetitionActionable(tableId);
    const data = parsed.data;
    const requestHash = canonicalActionHash({
      tableId,
      principalId,
      turnId: data.turnId,
      expectedVersion: data.expectedVersion,
      actionId: data.actionId,
      amount: data.amount,
    });

    const result = await this.runMutationWithLock(
      {
        tableId,
        principalId,
        expectedVersion: data.expectedVersion,
        canonical: true,
        requestId: data.requestId,
        turnId: data.turnId,
        actionId: data.actionId,
        amount: data.amount,
        requestHash,
      },
      false,
      // Canonical submissions fall back to lockless DB CAS if coordination is
      // unavailable; the database is the authority either way.
      "fallback"
    );

    if (result.kind === "noop") {
      throw new GameAuthorityError("GAME_CONFLICT", "Concurrent modification detected", 409);
    }
    // The stored idempotency result is exactly the shared CanonicalActionResult
    // ({receipt, observation}); `replayed` is a transient server-side flag for
    // audit/metrics and is stripped before the wire response.
    return { ...result.result, replayed: result.kind === "replay" };
  }

  /**
   * Internal management/worker mutation inside a caller-owned DB transaction.
   *
   * This is the additive transactional seam used by financial seating routes so
   * a chip/atomic financial mutation and the engine mutation share one atomic
   * boundary. It reuses the exact `applyMutationInTx` invariants: authoritative
   * snapshot read, CLOSED check, version/event cursor CAS, sealed public events,
   * transactional outbox and a masked wire view. There is no separate
   * post-commit engine call and no compensation path — a failure anywhere rolls
   * the whole transaction back.
   *
   * The actor is always the caller-supplied authenticated principal. Public
   * gameplay still goes through `submitCanonicalAction`; management families
   * (SIT/STAND/ADD_CHIPS) are never exposed through the strict canonical action
   * schema.
   */
  async applyManagementMutationInTx(
    tx: Prisma.TransactionClient,
    tableId: string,
    principalId: string,
    action: Action,
    options: ManagementMutationOptions = {}
  ): Promise<ManagementMutationResult> {
    if (
      !options.skipIdentity &&
      "playerId" in action &&
      action.playerId !== principalId &&
      action.type !== "TIMEOUT"
    ) {
      throw new GameAuthorityError(
        "IDENTITY_MISMATCH",
        "Identity mismatch: Cannot act for another player",
        403
      );
    }

    // SIT overwrites a seat unconditionally in the engine, so the authoritative
    // snapshot the CAS will commit against must be checked for occupancy.
    const validateSnapshot =
      action.type === "SIT"
        ? (snapshot: Snapshot) => {
            if (snapshot.players[action.seat]) {
              throw new GameAuthorityError(
                "SEAT_OCCUPIED",
                `Seat ${action.seat} is already occupied`,
                400
              );
            }
          }
        : undefined;

    const result = await this.applyMutationInTx(tx, {
      tableId,
      principalId,
      action,
      expectedVersion: options.expectedVersion,
      canonical: false,
      skipIdentity: options.skipIdentity,
      validateSnapshot,
    });

    if (result.kind === "noop") {
      return { applied: false, state: result.state, version: result.version, eventSeq: null };
    }
    return {
      applied: true,
      state: result.result.observation.state,
      version: result.result.receipt.version,
      eventSeq: result.result.receipt.eventSeq,
    };
  }

  /**
   * Read the authoritative table snapshot inside a caller-owned transaction.
   * Used by financial routes to validate seats/stacks against the same
   * PostgreSQL snapshot the engine CAS will commit.
   */
  async loadTransactionSnapshot(tx: Prisma.TransactionClient, tableId: string): Promise<Snapshot> {
    const record = await loadAuthoritativeTable(tx, tableId);
    if (!record || !record.snapshot) {
      throw new GameAuthorityError("TABLE_NOT_FOUND", "Table not found", 404);
    }
    return record.snapshot;
  }

  /**
   * Best-effort post-commit side-effect dispatch (outbox queues/pubsub + Redis
   * cache). Never throws: a Redis failure must not turn an already-committed
   * mutation into a falsely failed response.
   */
  async publishCommitted(tableId: string): Promise<void> {
    await this.dispatchAndCache(tableId);
  }

  /**
   * Authoritative per-seat observation: masked state + exact legal actions for
   * the current turn. Always reads the database, never Redis.
   */
  async getObservation(tableId: string, principalId?: string): Promise<SeatObservation> {
    const record = await loadAuthoritativeTable(this.prisma, tableId);
    if (!record || !record.snapshot) throw new NotFoundError("Table state");
    const engine = PokerEngine.restore(record.snapshot);
    return this.buildObservation(
      tableId,
      engine,
      record.stateVersion,
      record.eventSeq,
      principalId
    );
  }

  /** Get current authoritative state with view masking (engine shape). */
  async getState(tableId: string, userId?: string): Promise<PublicState> {
    const snapshot = await this.readAuthoritativeSnapshot(tableId);
    const engine = PokerEngine.restore(snapshot);
    return engine.view(userId, snapshot._version ?? 0);
  }

  async createTable(config: {
    name: string;
    mode: "CASH" | "TOURNAMENT";
    smallBlind: number;
    bigBlind: number;
    maxPlayers: number;
    minBuyIn?: number;
    maxBuyIn?: number;
    blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
    startingStack?: number;
    ante?: number;
    rakePercent?: number;
    rakeCap?: number;
    noFlopNoDrop?: boolean;
    timeBankSeconds?: number;
    timeBankDeductionSeconds?: number;
    actionTimeoutSeconds?: number;
    allowSpectators?: boolean;
  }): Promise<string> {
    const { tableId, snapshot } = await this.prisma.$transaction(
      (tx) => this.createTableInTx(tx, config),
      { maxWait: 10_000, timeout: 15_000 }
    );

    try {
      await this.redis.set(
        `table:${tableId}`,
        JSON.stringify(snapshot),
        "EX",
        appConfig.TABLE_REDIS_TTL_SECONDS
      );
    } catch {
      // Redis is only a cache; table creation already committed to the DB.
    }

    return tableId;
  }

  /**
   * Create a table, its initial durable snapshot and the sealed TABLE_CREATED
   * event inside a caller-owned transaction. This is the atomic admission seam
   * used by generic provisioning (e.g. competitions), so a table can never be
   * visible without its owning metadata, roster or financial reservation. The
   * caller owns the transaction boundary and any post-commit cache/dispatch.
   */
  async createTableInTx(
    tx: Prisma.TransactionClient,
    config: {
      name: string;
      mode: "CASH" | "TOURNAMENT";
      smallBlind: number;
      bigBlind: number;
      maxPlayers: number;
      minBuyIn?: number;
      maxBuyIn?: number;
      blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
      startingStack?: number;
      ante?: number;
      rakePercent?: number;
      rakeCap?: number;
      noFlopNoDrop?: boolean;
      timeBankSeconds?: number;
      timeBankDeductionSeconds?: number;
      actionTimeoutSeconds?: number;
      allowSpectators?: boolean;
    }
  ): Promise<{ tableId: string; snapshot: Snapshot }> {
    const engineConfig: {
      smallBlind: number;
      bigBlind: number;
      maxPlayers: number;
      ante?: number;
      rakePercent?: number;
      rakeCap?: number;
      noFlopNoDrop?: boolean;
      timeBankSeconds?: number;
      timeBankDeductionSeconds?: number;
      blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
    } = {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      maxPlayers: config.maxPlayers,
      ante: config.ante,
      rakePercent: config.rakePercent,
      rakeCap: config.rakeCap,
      noFlopNoDrop: config.noFlopNoDrop,
      timeBankSeconds: config.timeBankSeconds,
      timeBankDeductionSeconds: config.timeBankDeductionSeconds,
    };
    if (config.mode === "TOURNAMENT") {
      engineConfig.blindStructure =
        config.blindStructure ?? defaultBlindStructure(config.smallBlind, config.bigBlind);
    }

    const engine = new PokerEngine(engineConfig);
    const snapshot: Snapshot = engine.snapshot;
    snapshot._version = 0;

    const created = await tx.table.create({
      data: {
        name: config.name,
        mode: config.mode,
        config: JSON.parse(JSON.stringify(config)) as Prisma.InputJsonValue,
        status: "WAITING",
        state: JSON.stringify(snapshot),
        stateVersion: 0,
        eventSeq: 1,
      },
    });
    const events = sealEvents(created.id, 0, 1, null, [
      buildTableCreatedEvent(JSON.parse(JSON.stringify(config)) as Record<string, unknown>),
    ]);
    await insertGameEvents(tx, created.id, events);
    return { tableId: created.id, snapshot };
  }

  /**
   * Competition-managed tables only accept play while their competition is
   * RUNNING and fully seated. Registration/partial seating and post-settlement
   * states fail closed for public and worker mutations; director/management
   * mutations (skipIdentity) are exempt. Non-competition tables are unaffected.
   */
  private async assertCompetitionActionable(tableId: string): Promise<void> {
    const table = await this.prisma.table.findUnique({
      where: { id: tableId },
      select: { tournamentId: true },
    });
    if (!table?.tournamentId) return;
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: table.tournamentId },
      select: { competition: { select: { status: true, startedAt: true } } },
    });
    const competition = tournament?.competition;
    if (!competition) return;
    if (competition.status !== "RUNNING" || competition.startedAt === null) {
      throw new GameAuthorityError(
        "COMPETITION_NOT_ACTIONABLE",
        "Competition is not open for play",
        409
      );
    }
  }

  /** Append a bounded public chat message to the table's immutable event log. */
  async appendChat(tableId: string, principalId: string, body: string): Promise<ChatMessageView> {
    const trimmed = body.trim();
    if (trimmed.length < 1 || trimmed.length > 2000) {
      throw new GameAuthorityError("INVALID_CANONICAL_ACTION", "Invalid chat message", 400);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const record = await loadAuthoritativeTable(this.prisma, tableId);
      if (!record) throw new NotFoundError("Table");
      if (record.status === "CLOSED") {
        throw new GameAuthorityError("TABLE_CLOSED", "Table is closed", 409);
      }
      const messageId = `chat_${tableId}_${record.eventSeq + 1}`;
      const sentAt = Date.now();
      const eventSeq = record.eventSeq + 1;
      // Bind the message to the authoritative hand at append time. Chat never
      // advances `stateVersion`; the hand id comes from durable game state.
      const handId = record.snapshot?.handId ?? "initial";
      try {
        const applied = await this.prisma.$transaction(
          async (tx) => {
            const previousEvent = await tx.gameEvent.findFirst({
              where: { tableId },
              orderBy: { eventSeq: "desc" },
              select: { hash: true },
            });
            const sealed = sealEvents(
              tableId,
              record.stateVersion,
              eventSeq,
              previousEvent?.hash ?? null,
              [buildChatEvent({ messageId, handId, principalId, body: trimmed, sentAt })]
            );
            const updated = await tx.table.updateMany({
              where: { id: tableId, eventSeq: record.eventSeq, status: { not: "CLOSED" } },
              data: { eventSeq },
            });
            if (updated.count !== 1) return false;
            await insertGameEvents(tx, tableId, sealed);
            return true;
          },
          { maxWait: 10_000, timeout: 15_000 }
        );
        if (applied) {
          return { messageId, tableId, handId, eventSeq, principalId, body: trimmed, sentAt };
        }
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
      }
    }
    throw new GameAuthorityError("GAME_CONFLICT", "Failed to append chat message", 409);
  }

  async listChat(
    tableId: string,
    options: { beforeSeq?: number; limit?: number } = {}
  ): Promise<{ tableId: string; messages: ChatMessageView[]; nextBeforeSeq: number | null }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.prisma.gameEvent.findMany({
      where: {
        tableId,
        type: "CHAT_MESSAGE",
        ...(options.beforeSeq !== undefined ? { eventSeq: { lt: options.beforeSeq } } : {}),
      },
      orderBy: { eventSeq: "desc" },
      take: limit,
    });
    // Rows written before `handId` was persisted still project a valid hand id
    // from the current authoritative snapshot rather than an ad-hoc alias.
    const fallbackHandId = rows.some(
      (row) => typeof (row.payload as { handId?: unknown } | null)?.handId !== "string"
    )
      ? ((await loadAuthoritativeTable(this.prisma, tableId))?.snapshot?.handId ?? "initial")
      : "initial";
    const messages = rows
      .map((row) => {
        const payload = (row.payload ?? {}) as {
          messageId?: string;
          handId?: string;
          principalId?: string;
          body?: string;
          sentAt?: number;
        };
        return {
          messageId: payload.messageId ?? row.id,
          tableId,
          handId: payload.handId ?? fallbackHandId,
          eventSeq: row.eventSeq,
          principalId: payload.principalId ?? "",
          body: payload.body ?? "",
          sentAt: payload.sentAt ?? row.occurredAt.getTime(),
        };
      })
      .reverse();
    return {
      tableId,
      messages,
      nextBeforeSeq: rows.length === limit ? rows[rows.length - 1].eventSeq : null,
    };
  }

  /**
   * Ordered PUBLIC event replay with hash-chain verification. Event payloads are
   * masked by construction and never contain deck order, undealt cards or
   * another seat's hole cards.
   *
   * The frame is one contiguous slice of the same append-only ordering: every
   * sliced event's hash is recomputed against its persisted `previousHash` and,
   * for a non-genesis slice, against the anchor hash of the record immediately
   * before `fromEventSeq`. The slice is bounded by `Table.eventSeq` and the
   * repository pagination limit, and `chainValid` is never true when the slice
   * is non-contiguous, tampered, unanchored or does not reach its requested end.
   */
  async replay(
    tableId: string,
    fromEventSeq: number,
    toEventSeq?: number
  ): Promise<ReplayFrameView> {
    const table = await this.prisma.table.findUnique({
      where: { id: tableId },
      select: { eventSeq: true, mode: true, tournamentId: true },
    });
    if (!table) throw new NotFoundError("Table");

    const headEventSeq = table.eventSeq;
    // Final bound: never read past the authoritative event cursor. A caller may
    // request an earlier end (pagination), but never beyond the head.
    const effectiveTo =
      toEventSeq === undefined ? headEventSeq : Math.min(toEventSeq, headEventSeq);

    const rows = await this.prisma.gameEvent.findMany({
      where: { tableId, eventSeq: { gte: fromEventSeq, lte: effectiveTo } },
      orderBy: { eventSeq: "asc" },
      take: 500,
    });
    const events: ReplayFrameEvent[] = rows.map((row) => ({
      eventId: row.id,
      tableId,
      eventSeq: row.eventSeq,
      version: row.version,
      type: row.type as ReplayFrameEvent["type"],
      occurredAt: row.occurredAt.getTime(),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      previousHash: row.previousHash,
      hash: row.hash,
      turnId: row.turnId,
      requestId: row.requestId,
      actionId: row.actionId,
    }));

    // Starting anchor: the persisted hash of the record immediately before the
    // slice. A non-genesis slice without its prior record cannot be validated.
    let anchorHash: string | null = null;
    if (fromEventSeq > 1) {
      const previous = await this.prisma.gameEvent.findFirst({
        where: { tableId, eventSeq: fromEventSeq - 1 },
        select: { hash: true },
      });
      anchorHash = previous?.hash ?? null;
    }

    const contiguous = events.every(
      (event, index) => index === 0 || event.eventSeq === events[index - 1].eventSeq + 1
    );
    const reachesRequestedEnd =
      events.length > 0
        ? events[events.length - 1].eventSeq === effectiveTo
        : fromEventSeq > effectiveTo;
    const anchorPresent = fromEventSeq === 1 || anchorHash !== null;
    const hashesValid = verifyEventChain(tableId, events, {
      anchorHash,
      expectedFirstSeq: fromEventSeq,
    });
    // An empty slice inside the log (fromEventSeq <= head) is missing events and
    // must not claim validity; a slice that stops short of its requested end is
    // likewise not valid.
    const chainValid = contiguous && reachesRequestedEnd && anchorPresent && hashesValid;

    const tournamentEvents =
      table.mode === "TOURNAMENT" && table.tournamentId
        ? await listTournamentEvents(this.prisma, table.tournamentId)
        : undefined;

    return {
      tableId,
      fromEventSeq,
      toEventSeq: effectiveTo,
      anchorHash,
      headEventSeq,
      events,
      chainValid,
      ...(tournamentEvents ? { tournamentEvents } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runMutationWithLock(
    input: MutationInput,
    skipLock: boolean | undefined,
    lockFailure: "throw" | "fallback"
  ): Promise<MutationTxResult> {
    const lockTTL =
      appConfig.NODE_ENV === "test"
        ? appConfig.TABLE_LOCK_TTL_MS_TEST
        : appConfig.TABLE_LOCK_TTL_MS;

    let lock: Awaited<ReturnType<Redlock["lock"]>> | null = null;
    if (!skipLock) {
      try {
        lock = await this.redlock.lock([`lock:table:${input.tableId}`], lockTTL);
      } catch (error) {
        if (lockFailure === "throw") throw error;
        // Canonical path: Redis coordination is optional; DB CAS is authority.
        lock = null;
      }
    }

    try {
      let result: MutationTxResult | null = null;
      let attempt = 0;
      while (result === null) {
        try {
          result = await this.runMutation(input);
        } catch (error) {
          if (isUniqueConstraintError(error) && input.requestId && input.requestHash) {
            const replay = await this.replayCommittedRequest(
              input.tableId,
              input.requestId,
              input.requestHash,
              input.principalId
            );
            if (replay) return { kind: "replay", result: replay };
          }
          if (isRetryableConflict(error) && attempt < 8) {
            // Transient DB write conflict (SQLite P2034/P1008, PostgreSQL
            // deadlock/serialization): retry the whole transaction with bounded
            // jittered backoff. The CAS is always re-evaluated against the
            // current durable row, so a retry cannot double-apply an action.
            attempt += 1;
            const backoffMs = Math.min(25 * attempt + Math.random() * 25, 400);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          if (isRetryableConflict(error)) {
            throw new GameAuthorityError(
              "GAME_CONFLICT",
              "Concurrent modification detected - state changed during operation",
              409
            );
          }
          throw error;
        }
      }

      if (result.kind === "applied") {
        await this.dispatchAndCache(input.tableId);
      }
      return result;
    } finally {
      // Redis unlock failure must never turn an accepted DB commit into a
      // falsely failed response.
      if (lock) {
        try {
          await lock.unlock();
        } catch {
          // Ignore: the lock TTL will release it.
        }
      }
    }
  }

  private async dispatchAndCache(tableId: string): Promise<void> {
    try {
      await dispatchPendingOutbox(this.prisma, this.queues, this.redis, {
        tableId,
        limit: 200,
      });
    } catch {
      // Outbox rows are durable and dispatched by recovery.
    }
    try {
      const record = await loadAuthoritativeTable(this.prisma, tableId);
      if (record?.snapshot) {
        await this.redis.set(
          `table:${tableId}`,
          JSON.stringify(record.snapshot),
          "EX",
          appConfig.TABLE_REDIS_TTL_SECONDS
        );
      }
    } catch {
      // Ignore cache write failure.
    }
  }

  private async runMutation(input: MutationInput): Promise<MutationTxResult> {
    return this.prisma.$transaction(async (tx) => this.applyMutationInTx(tx, input), {
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  private async applyMutationInTx(
    tx: Prisma.TransactionClient,
    input: MutationInput
  ): Promise<MutationTxResult> {
    const record = await loadAuthoritativeTable(tx, input.tableId);
    if (!record || !record.snapshot) {
      throw new GameAuthorityError("TABLE_NOT_FOUND", "Table not found", 404);
    }
    if (record.status === "CLOSED") {
      throw new GameAuthorityError("TABLE_CLOSED", "Table is closed", 409);
    }

    // Idempotency: dedicated keyed record (canonical path only). Actor + complete
    // payload must match before any original result is returned.
    let actionRequestId: string | null = null;
    if (input.requestId) {
      if (!input.requestHash || !input.turnId || !input.actionId) {
        throw new GameAuthorityError(
          "INVALID_CANONICAL_ACTION",
          "Canonical request missing correlation fields",
          400
        );
      }
      const existing = await findActionRequest(tx, input.tableId, input.requestId);
      if (existing) {
        if (
          existing.principalId !== input.principalId ||
          existing.requestHash !== input.requestHash
        ) {
          throw new GameAuthorityError(
            "REQUEST_ID_CONFLICT",
            "requestId was already used for a different actor or request",
            409
          );
        }
        if (existing.status === "COMPLETED" && existing.response) {
          return {
            kind: "replay",
            result: CanonicalActionResultSchema.parse(existing.response),
          };
        }
        throw new GameAuthorityError(
          "REQUEST_ID_CONFLICT",
          "A request with this requestId is still processing",
          409
        );
      }
      const created = await createActionRequest(tx, {
        tableId: input.tableId,
        requestId: input.requestId,
        principalId: input.principalId,
        turnId: input.turnId,
        actionId: input.actionId,
        expectedVersion: input.expectedVersion ?? record.stateVersion,
        requestHash: input.requestHash,
      });
      actionRequestId = created.id;
    }

    // CAS/version gate.
    const expectedVersion = input.expectedVersion ?? record.stateVersion;
    if (expectedVersion !== record.stateVersion) {
      if (input.canonical) {
        throw new GameAuthorityError(
          "GAME_CONFLICT",
          `Version mismatch: expected ${expectedVersion}, found ${record.stateVersion}`,
          409
        );
      }
      const engine = PokerEngine.restore(record.snapshot);
      return {
        kind: "noop",
        version: record.stateVersion,
        state: toPublicWireState(engine.view(input.principalId, record.stateVersion)),
      };
    }

    const previousSnapshot = record.snapshot;
    // Caller-supplied invariant against the exact snapshot the CAS will act on.
    // A throw here aborts the entire (possibly financial + engine) transaction.
    input.validateSnapshot?.(previousSnapshot);
    const engine = PokerEngine.restore(previousSnapshot);
    const derivedTurnId = deriveTurnId({
      tableId: input.tableId,
      handId: previousSnapshot.handId,
      version: record.stateVersion,
      actionTo: previousSnapshot.actionTo,
    });

    let engineAction: Action;
    if (input.canonical) {
      if (derivedTurnId !== input.turnId) {
        throw new GameAuthorityError(
          "STALE_TURN",
          "The submitted turnId is not the current authoritative turn",
          409
        );
      }
      // Resolve the opaque actionId against the issued legal actions; never
      // parse it. This also enforces parameter bounds via engine validation.
      const legal = getLegalActions(engine, derivedTurnId, input.principalId);
      const matched = legal.find((candidate) => candidate.actionId === input.actionId);
      if (!matched) {
        throw new GameAuthorityError(
          "INVALID_CANONICAL_ACTION",
          "Action is not legal for this turn",
          400
        );
      }
      engineAction = legalFamilyToEngineAction(
        matched.family,
        input.principalId,
        input.amount ?? matched.amount
      );
      this.assertSeatAuthority(previousSnapshot, engineAction.type, input.principalId);
    } else {
      if (!input.action) {
        throw new GameAuthorityError("INVALID_CANONICAL_ACTION", "Missing action", 400);
      }
      engineAction = input.action;
    }

    try {
      engine.act(engineAction);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        throw new GameAuthorityError("GAME_ACTION_REJECTED", error.message, 400);
      }
      throw error;
    }

    const newVersion = record.stateVersion + 1;
    const newSnapshot: Snapshot = engine.snapshot;
    newSnapshot._version = newVersion;

    const handCompleted =
      !!engine.state.winners &&
      (!previousSnapshot.winners || previousSnapshot.handId !== engine.state.handId);

    const pendingEvents: PendingGameEvent[] = [];
    if (engineAction.type === "DEAL") {
      pendingEvents.push(buildHandStartedEvent(engine.state));
    } else {
      const event = buildActionEvent(engineAction, engine.state);
      pendingEvents.push({
        ...event,
        turnId: derivedTurnId,
        requestId: input.requestId ?? null,
        actionId: input.actionId ?? engineAction.type,
      });
    }
    if (handCompleted) {
      pendingEvents.push(buildHandCompletedEvent(engine.state));
    }

    const newEventSeq = record.eventSeq + pendingEvents.length;

    const applied = await compareAndSetState(tx, {
      tableId: input.tableId,
      expectedVersion: record.stateVersion,
      expectedEventSeq: record.eventSeq,
      newVersion,
      newSnapshot,
      newEventSeq,
    });
    if (!applied) {
      throw new GameAuthorityError(
        "GAME_CONFLICT",
        "Concurrent modification detected - state changed during operation",
        409
      );
    }

    const previousEvent = await tx.gameEvent.findFirst({
      where: { tableId: input.tableId },
      orderBy: { eventSeq: "desc" },
      select: { hash: true },
    });
    const sealed = sealEvents(
      input.tableId,
      newVersion,
      record.eventSeq + 1,
      previousEvent?.hash ?? null,
      pendingEvents
    );
    await insertGameEvents(tx, input.tableId, sealed);

    const intents = this.planSideEffects({
      tableId: input.tableId,
      engine,
      newVersion,
      newEventSeq,
      handCompleted,
    });
    await writeOutboxIntents(tx, input.tableId, intents);

    const acceptedAt = Date.now();
    const observation = this.buildObservation(
      input.tableId,
      engine,
      newVersion,
      newEventSeq,
      input.principalId
    );
    const result: CanonicalActionResult = {
      receipt: {
        requestId: input.requestId ?? "",
        tableId: input.tableId,
        handId: engine.state.handId,
        turnId: derivedTurnId,
        actionId: input.actionId ?? engineAction.type,
        version: newVersion,
        eventSeq: newEventSeq,
        acceptedAt,
      },
      observation,
    };

    if (actionRequestId) {
      await completeActionRequest(tx, actionRequestId, {
        response: JSON.parse(JSON.stringify(result)) as unknown,
        resultVersion: newVersion,
        eventSeq: newEventSeq,
      });
    }

    return { kind: "applied", result };
  }

  private buildObservation(
    tableId: string,
    engine: PokerEngine,
    version: number,
    eventSeq: number,
    principalId?: string
  ): SeatObservation {
    const turnId = deriveTurnId({
      tableId,
      handId: engine.state.handId,
      version,
      actionTo: engine.state.actionTo,
    });
    // A viewer identity is only attached to a seat that actually exists in the
    // authoritative engine state. An authenticated non-seated principal is a
    // spectator: forwarding their id would mark a purely-claimed viewer in the
    // masked state and fail the shared strict PublicWireState contract (which
    // requires viewingPlayerId to reference a seated player).
    const viewerId =
      principalId !== undefined && engine.state.players.some((player) => player?.id === principalId)
        ? principalId
        : undefined;
    const legalActions = viewerId
      ? getLegalActions(engine, turnId, viewerId)
      : ([] as LegalAction[]);
    return {
      tableId,
      handId: engine.state.handId,
      turnId,
      version,
      eventSeq,
      state: toPublicWireState(engine.view(viewerId, version)),
      legalActions,
    };
  }

  private assertSeatAuthority(
    snapshot: Snapshot,
    actionType: Action["type"],
    principalId: string
  ): void {
    switch (actionType) {
      // Table-level/management families are not seat-scoped.
      case "DEAL":
      case "NEXT_BLIND_LEVEL":
        return;
      // Seat-scoped families that are not tied to owning the current betting
      // turn: at a showdown/hand boundary `actionTo` is null, so SHOW/MUCK must
      // be authorized against the durable seat, not the pending-turn seat.
      case "STAND":
      case "SHOW":
      case "MUCK": {
        const seated = snapshot.players.some((player) => player?.id === principalId);
        if (!seated) {
          throw new GameAuthorityError("IDENTITY_MISMATCH", "Principal is not seated", 403);
        }
        return;
      }
      default: {
        const ownsTurn =
          snapshot.actionTo !== null && snapshot.players[snapshot.actionTo]?.id === principalId;
        if (!ownsTurn) {
          throw new GameAuthorityError(
            "IDENTITY_MISMATCH",
            "Principal does not own the acting seat",
            403
          );
        }
      }
    }
  }

  private planSideEffects(input: {
    tableId: string;
    engine: PokerEngine;
    newVersion: number;
    newEventSeq: number;
    handCompleted: boolean;
  }): OutboxIntent[] {
    const { tableId, engine, newVersion, newEventSeq, handCompleted } = input;
    const state = engine.state;
    const intents: OutboxIntent[] = [];

    if (handCompleted) {
      const handId = `${tableId}_${state.handId}`;
      if (!state.config.blindStructure) {
        const playerNetChanges: Record<string, string> = {};
        for (const player of state.players) {
          if (!player) continue;
          const awarded = (state.winners ?? [])
            .filter((winner) => winner.seat === player.seat)
            .reduce((sum, winner) => sum + winner.amount, 0);
          const netChange = awarded - player.totalInvestedThisHand;
          if (netChange !== 0) playerNetChanges[player.id] = netChange.toString();
        }
        intents.push({
          kind: "settle-hand",
          dedupeKey: `settle:${handId}`,
          payload: {
            tableId,
            handId,
            playerNetChanges,
            rakeTotal: state.rakeThisHand.toString(),
          },
        });
      }
      intents.push({
        kind: "archive-hand",
        dedupeKey: `archive:${handId}`,
        // Private audit boundary: the archive worker needs the unmasked
        // snapshot to produce a hand history. This payload is never exposed to
        // public replay/events.
        payload: { tableId, handId, snapshot: engine.snapshot },
      });
      const activePlayers = state.players.filter((p) => p && p.stack > 0).length;
      if (activePlayers >= 2) {
        intents.push({
          kind: "next-hand",
          dedupeKey: `next-hand:${handId}`,
          payload: { tableId, expectedVersion: newVersion },
          availableAt: new Date(Date.now() + appConfig.AUTO_DEAL_DELAY_MS),
        });
      }
    } else {
      const timeout = this.planTimeout(tableId, state, newVersion);
      if (timeout) intents.push(timeout);
    }

    intents.push({
      kind: "pubsub",
      dedupeKey: `pubsub:${tableId}:${newVersion}`,
      payload: {
        channel: `pubsub:table:${tableId}`,
        type: "STATE_UPDATE",
        tableId,
        version: newVersion,
        eventSeq: newEventSeq,
        timestamp: Date.now(),
      },
    });

    return intents;
  }

  private planTimeout(tableId: string, state: GameState, version: number): OutboxIntent | null {
    if (state.actionTo === null) return null;
    const player = state.players[state.actionTo];
    if (!player) return null;

    const storedConfig = state.config as typeof state.config & { actionTimeoutSeconds?: number };
    const baseTimeoutSeconds =
      storedConfig.actionTimeoutSeconds ?? appConfig.ACTION_TIMEOUT_SECONDS;
    let timeoutSeconds = baseTimeoutSeconds;
    if (state.timeBankActiveSeat === state.actionTo) {
      const timeBankDeduction = state.config.timeBankDeductionSeconds ?? 10;
      timeoutSeconds = baseTimeoutSeconds + timeBankDeduction;
    }

    return {
      kind: "player-timeout",
      dedupeKey: `timeout:${tableId}:${state.actionTo}:${version}`,
      payload: { tableId, playerId: player.id, expectedVersion: version },
      availableAt: new Date(Date.now() + timeoutSeconds * 1000),
    };
  }

  private async replayCommittedRequest(
    tableId: string,
    requestId: string,
    requestHash: string,
    principalId: string
  ): Promise<CanonicalActionResult | null> {
    const existing = await this.prisma.gameActionRequest.findUnique({
      where: { tableId_requestId: { tableId, requestId } },
    });
    if (!existing) return null;
    if (existing.principalId !== principalId || existing.requestHash !== requestHash) {
      throw new GameAuthorityError(
        "REQUEST_ID_CONFLICT",
        "requestId was already used for a different actor or request",
        409
      );
    }
    if (existing.status === "COMPLETED" && existing.response) {
      return CanonicalActionResultSchema.parse(existing.response);
    }
    throw new GameAuthorityError(
      "REQUEST_ID_CONFLICT",
      "A request with this requestId is still processing",
      409
    );
  }

  private async readAuthoritativeSnapshot(tableId: string): Promise<Snapshot> {
    const record = await loadAuthoritativeTable(this.prisma, tableId);
    if (!record || !record.snapshot) throw new NotFoundError("Table state");
    return record.snapshot;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function isRetryableConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  if (code === "P2034") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("timed out");
}
