import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import type { ActionType } from "@pokertools/types";
import {
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  CanonicalActionRequestSchema,
  CanonicalActionResultSchema,
  SeatObservationSchema,
  ChatMessageSchema,
  ChatPageSchema,
  ReplayFrameSchema,
  toPublicWireState,
} from "@pokertools/types";
import type { AuthenticatedPrincipal } from "../../services/principal-manager.js";
import { config } from "../../config.js";
import { getHouseUserId } from "../../utils/house-user.js";
import { reconcileTournament } from "../../services/tournament-director.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only transient concurrency/transaction conflicts are safe to retry as a whole
 * unit: the financial + engine transaction is idempotent (chip and hand markers)
 * and never partially applies. Business rejections fail immediately.
 */
function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  if (code === "P2034" || code === "CHIP_CONCURRENT_MODIFICATION") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("timed out");
}

async function retryTransaction<T>(operation: () => Promise<T>, attempts = 8): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === attempts) throw error;
      await sleep(25 * attempt);
    }
  }
  throw lastError;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Competition-managed rosters are provisioned and seated by the platform; the
 * generic table routes must not admit outsiders or drift engine state for them.
 * Self-register tournaments and cash tables keep their existing behavior.
 */
async function competitionManagedTableError(
  fastify: FastifyInstance,
  tableId: string
): Promise<{ statusCode: number; code: string; message: string } | null> {
  const table = await fastify.prisma.table.findUnique({
    where: { id: tableId },
    select: { tournamentId: true },
  });
  if (!table?.tournamentId) return null;
  const tournament = await fastify.prisma.tournament.findUnique({
    where: { id: table.tournamentId },
    select: { competition: { select: { id: true } } },
  });
  if (!tournament?.competition) return null;
  return {
    statusCode: 403,
    code: "COMPETITION_MANAGED_TABLE",
    message: "Competition-managed roster cannot be changed through table routes",
  };
}

function parseRequiredInteger(value: string | undefined): number | undefined {
  return parseOptionalInteger(value);
}

// ---------------------------------------------------------------------------
// Chat body hygiene. Stored text is escaped so it is HTML-inert on render, and
// page sizes are clamped to a bounded server range.
// ---------------------------------------------------------------------------

const CHAT_MAX_BODY_LENGTH = 2000;
const CHAT_MAX_PAGE_SIZE = 200;
const CHAT_DEFAULT_PAGE_SIZE = 50;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function sanitizeChatBody(body: string): string {
  const escaped = body.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
  return escaped.slice(0, CHAT_MAX_BODY_LENGTH);
}

function clampChatLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CHAT_DEFAULT_PAGE_SIZE;
  return Math.min(CHAT_MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------
// Canonical response validation. Public responses are validated against the
// shared schemas at runtime so an internal shape drift cannot leak a malformed
// or unmasked projection to clients.
// ---------------------------------------------------------------------------

/**
 * Any canonical response that fails the shared strict contract is a server-side
 * projection failure: fail closed with 503 rather than leaking a malformed or
 * unmasked projection (or claiming success).
 */
function invalidServerResponse(cause: unknown): Error {
  return Object.assign(new Error("Canonical response failed schema validation"), {
    statusCode: 503,
    code: "INVALID_SERVER_RESPONSE",
    cause,
  });
}

/**
 * Canonical turn ids are always non-empty strings, including at a hand
 * boundary (`...:none`). There is no nullable-turn observation, so the full
 * shared strict contract must validate on every response.
 */
function assertSeatObservation(observation: unknown): void {
  const parsed = SeatObservationSchema.safeParse(observation);
  if (!parsed.success) throw invalidServerResponse(parsed.error);
}

function assertCanonicalActionResult(result: unknown): void {
  const parsed = CanonicalActionResultSchema.safeParse(result);
  if (!parsed.success) throw invalidServerResponse(parsed.error);
}

function assertChatMessage(message: unknown): void {
  const parsed = ChatMessageSchema.safeParse(message);
  if (!parsed.success) throw invalidServerResponse(parsed.error);
}

function assertChatPage(page: unknown): void {
  const parsed = ChatPageSchema.safeParse(page);
  if (!parsed.success) throw invalidServerResponse(parsed.error);
}

/**
 * The replay frame is the shared strict contract (hash-chain provenance,
 * head bound, integrity flag, masked events). An internal shape drift must not
 * reach clients as a valid-looking frame.
 */
function assertReplayFrame(frame: unknown): void {
  const parsed = ReplayFrameSchema.safeParse(frame);
  if (!parsed.success) throw invalidServerResponse(parsed.error);
}

/**
 * The acting/viewing seat is resolved from durable game state, never from the
 * request body. A seat-restricted SERVICE credential fails closed when its seat
 * cannot be established; wallet principals are unrestricted.
 */
async function persistedSeatFor(
  fastify: FastifyInstance,
  tableId: string,
  principal: AuthenticatedPrincipal
): Promise<number | null> {
  if (principal.restrictions.seat === null) return null;
  const state = await fastify.gameManager.getState(tableId).catch(() => null);
  const index = state?.players.findIndex((player) => player?.id === principal.id) ?? -1;
  return index >= 0 ? index : null;
}

export const tableRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /tables - List active tables
  fastify.get<{ Querystring: { mode?: "CASH" | "TOURNAMENT" } }>("/", async (request, reply) => {
    const { mode } = request.query;
    if (mode !== undefined && mode !== "CASH" && mode !== "TOURNAMENT") {
      return reply.code(400).send({ error: "Invalid table mode" });
    }
    const tables = await fastify.prisma.table.findMany({
      where: {
        status: { in: ["WAITING", "ACTIVE"] },
        ...(mode ? { mode } : {}),
      },
      select: {
        id: true,
        name: true,
        config: true,
        status: true,
      },
      take: config.TABLE_LISTING_PAGE_SIZE,
      orderBy: { updatedAt: "desc" },
    });

    return { tables };
  });

  // POST /tables - Create new table
  fastify.post<{
    Body: CreateTableRequest;
  }>(
    "/",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const tableId = await fastify.gameManager.createTable(request.body);
      return { tableId };
    }
  );

  // GET /tables/:id - Get table state
  // Supports ?since=<version> for efficient state synchronization
  fastify.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const { userId } = request.user;
      const { since } = request.query;

      const state = await fastify.gameManager.getState(id, userId);

      if (since !== undefined) {
        const sinceVersion = parseInt(since, 10);
        if (!isNaN(sinceVersion) && state.version <= sinceVersion) {
          return reply.code(304).send();
        }
      }

      return { state: toPublicWireState(state) };
    }
  );

  // POST /tables/:id/buy-in - Buy into table
  fastify.post<{
    Params: { id: string };
    Body: BuyInRequest;
  }>(
    "/:id/buy-in",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const { userId } = request.user;
      const { amount, seat, idempotencyKey } = request.body;

      if (!idempotencyKey) {
        return reply.code(400).send({ error: "idempotencyKey is required" });
      }

      const competitionManaged = await competitionManagedTableError(fastify, id);
      if (competitionManaged) {
        return reply.code(competitionManaged.statusCode).send({
          error: competitionManaged.code,
          message: competitionManaged.message,
        });
      }

      const amountNum = typeof amount === "string" ? parseInt(amount, 10) : amount;
      const buyInTable = await fastify.prisma.table.findUniqueOrThrow({
        where: { id },
        select: { config: true, mode: true },
      });
      const buyInConfig = buyInTable.config as { minBuyIn?: number; maxBuyIn?: number };
      if (
        buyInTable.mode === "CASH" &&
        buyInConfig.minBuyIn !== undefined &&
        amountNum < buyInConfig.minBuyIn
      ) {
        return reply.code(400).send({
          error: "BUY_IN_BELOW_MINIMUM",
          message: `Buy-in must be at least ${buyInConfig.minBuyIn}`,
        });
      }
      if (
        buyInTable.mode === "CASH" &&
        buyInConfig.maxBuyIn !== undefined &&
        amountNum > buyInConfig.maxBuyIn
      ) {
        return reply.code(400).send({
          error: "BUY_IN_ABOVE_MAXIMUM",
          message: `Buy-in must not exceed ${buyInConfig.maxBuyIn}`,
        });
      }
      const risk = await fastify.riskManager.assertAllowed({
        userId,
        endpoint: "buy-in",
        request,
        chipAmount: amountNum,
      });

      const actorId = userId;
      const idem = await fastify.idempotencyManager.run({
        key: idempotencyKey,
        scope: `buy-in:${id}`,
        userId,
        requestHash: fastify.idempotencyManager.hash({ id, amount: amountNum, seat }),
        handler: async () => {
          const table = await fastify.prisma.table.findUniqueOrThrow({
            where: { id },
            select: { config: true, mode: true },
          });
          const tableConfig = table.config as { minBuyIn?: number; maxBuyIn?: number };
          if (
            table.mode === "CASH" &&
            tableConfig.minBuyIn !== undefined &&
            amountNum < tableConfig.minBuyIn
          ) {
            throw Object.assign(new Error(`Buy-in must be at least ${tableConfig.minBuyIn}`), {
              statusCode: 400,
              code: "BUY_IN_BELOW_MINIMUM",
            });
          }
          if (
            table.mode === "CASH" &&
            tableConfig.maxBuyIn !== undefined &&
            amountNum > tableConfig.maxBuyIn
          ) {
            throw Object.assign(new Error(`Buy-in must not exceed ${tableConfig.maxBuyIn}`), {
              statusCode: 400,
              code: "BUY_IN_ABOVE_MAXIMUM",
            });
          }
          const lock = await fastify.redlock.lock([`lock:table:${id}`], config.TABLE_LOCK_TTL_MS);
          try {
            // Single atomic boundary: the chip/atomic financial mutation AND the
            // engine SIT (snapshot CAS + version + events + idempotency + outbox)
            // commit together, or neither does. There is no post-commit engine
            // call and no compensation path that could strand chips.
            const applied = await retryTransaction(() =>
              fastify.prisma.$transaction(async (tx) => {
                const snapshot = await fastify.gameManager.loadTransactionSnapshot(tx, id);
                const seatedPlayer = snapshot.players[seat];

                if (seatedPlayer) {
                  if (seatedPlayer.id === actorId) return false;
                  throw Object.assign(new Error(`Seat ${seat} is already occupied`), {
                    statusCode: 400,
                    code: "SEAT_OCCUPIED",
                  });
                }

                const user = await tx.user.findUniqueOrThrow({
                  where: { id: actorId },
                  select: { username: true },
                });

                await fastify.financialManager.applyBuyIn(tx, actorId, id, BigInt(amountNum), {
                  idempotencyKey,
                });
                await fastify.gameManager.applyManagementMutationInTx(tx, id, actorId, {
                  type: "SIT" as ActionType.SIT,
                  playerId: actorId,
                  playerName: user.username,
                  seat,
                  stack: amountNum,
                });
                return true;
              })
            );

            if (applied) {
              // Best-effort only: the mutation is already durably committed.
              await fastify.gameManager.publishCommitted(id);
            }
            return { success: true };
          } finally {
            await lock.unlock();
          }
        },
      });

      if (idem.replayed) {
        fastify.observabilityManager.increment("pokertools_idempotency_hits_total", {
          scope: "buy-in",
        });
      }
      await fastify.auditManager.record({
        actorId: userId,
        action: "BUY_IN",
        resource: `table:${id}`,
        request,
        riskScore: risk.score,
        metadata: { amount: amountNum, seat, replayed: idem.replayed },
      });
      return idem.response;
    }
  );

  // GET /tables/:id/observation - Authoritative per-seat decision boundary
  //
  // Returns the masked public state plus the exact legal actions for the
  // authenticated principal at the current turn. Private hole cards are masked
  // server-side (only the viewer's own cards are visible), and a principal who
  // does not own the acting seat receives no legal actions.
  fastify.get<{ Params: { id: string } }>(
    "/:id/observation",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const authorization = fastify.authorizeTable(
        request,
        "table:observe",
        id,
        await persistedSeatFor(fastify, id, principal)
      );
      if (!authorization.allowed) {
        return reply.code(403).send({ error: authorization.reason });
      }

      const observation = await fastify.gameManager.getObservation(id, principal.id);
      assertSeatObservation(observation);
      return observation;
    }
  );

  // POST /tables/:id/action - Submit a strict canonical action
  //
  // The request carries only ids and an optional chip amount. Actor fields
  // (playerId/principalId/seat/actor) are rejected by the strict schema, and
  // the acting identity is derived from auth. Stale/unknown turns and version
  // conflicts are rejected by the game authority's compare-and-set.
  fastify.post<{ Params: { id: string } }>(
    "/:id/action",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const authorization = await fastify.principalManager.authorizeTableRequest({
        principal,
        scope: "table:act",
        tableId: id,
        persistedSeat: await persistedSeatFor(fastify, id, principal),
        canonicalAction: request.body,
      });
      if (!authorization.allowed) {
        return reply.code(403).send({ error: authorization.reason });
      }

      const parsed = CanonicalActionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_CANONICAL_ACTION",
          message: "Invalid canonical action request",
        });
      }

      try {
        const outcome = await fastify.gameManager.submitCanonicalAction(
          id,
          principal.id,
          parsed.data
        );
        const result = { receipt: outcome.receipt, observation: outcome.observation };
        assertCanonicalActionResult(result);

        fastify.observabilityManager.increment("pokertools_game_actions_total", {
          type: parsed.data.actionId,
        });
        // The action is already durably committed. An audit/metrics write must
        // never turn an accepted mutation into a falsely failed response; the
        // durable GameActionRequest + GameEvent rows remain the authority.
        try {
          await fastify.auditManager.record({
            actorId: principal.id,
            action: `GAME_${parsed.data.actionId}`,
            resource: `table:${id}`,
            request,
            metadata: {
              requestId: parsed.data.requestId,
              turnId: parsed.data.turnId,
              actionId: parsed.data.actionId,
              amount: parsed.data.amount,
              version: outcome.receipt.version,
              eventSeq: outcome.receipt.eventSeq,
              replayed: outcome.replayed,
            },
          });
        } catch {
          fastify.observabilityManager.increment("pokertools_audit_write_failures_total", {
            action: "GAME_ACTION",
          });
        }

        // Tournament director: after a hand completes on a tournament table,
        // trigger reconciliation (elimination tracking, rebalancing, final table merge).
        const winners = outcome.observation.state.winners;
        if (winners && winners.length > 0) {
          try {
            const table = await fastify.prisma.table.findUnique({
              where: { id },
              select: { mode: true, tournamentId: true },
            });
            if (table?.mode === "TOURNAMENT" && table.tournamentId) {
              await reconcileTournament(fastify, table.tournamentId, principal.id);
            }
          } catch {
            // The poker action has already committed. Do not turn a director
            // failure into an ambiguous failed mutation, but do not hide it.
            fastify.observabilityManager.increment(
              "pokertools_tournament_reconcile_failures_total"
            );
            fastify.log.warn(
              { tableId: id },
              "Tournament reconciliation deferred after accepted action"
            );
          }
        }

        // CanonicalActionResult: durable receipt + the resulting observation.
        return result;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "statusCode" in err &&
          "code" in err &&
          "message" in err
        ) {
          return reply.code(err.statusCode as number).send({
            error: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    }
  );

  // GET /tables/:id/chat - Bounded page of the append-only chat stream
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; beforeSeq?: string };
  }>(
    "/:id/chat",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const authorization = fastify.authorizeTable(
        request,
        "table:observe",
        id,
        await persistedSeatFor(fastify, id, principal)
      );
      if (!authorization.allowed) {
        return reply.code(403).send({ error: authorization.reason });
      }

      const beforeSeq = parseOptionalInteger(request.query.beforeSeq);
      if (beforeSeq !== undefined && beforeSeq < 0) {
        return reply
          .code(400)
          .send({ error: "INVALID_CHAT_QUERY", message: "beforeSeq must be non-negative" });
      }

      const page = await fastify.gameManager.listChat(id, {
        limit: clampChatLimit(parseOptionalInteger(request.query.limit)),
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      });
      assertChatPage(page);
      return page;
    }
  );

  // POST /tables/:id/chat - Append one bounded, HTML-inert chat message.
  //
  // Chat only advances `eventSeq` (never `stateVersion`); the body is escaped
  // before it is persisted so it can never be executed as markup.
  fastify.post<{ Params: { id: string }; Body: { body?: unknown } }>(
    "/:id/chat",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const authorization = fastify.authorizeTable(
        request,
        "table:chat",
        id,
        await persistedSeatFor(fastify, id, principal)
      );
      if (!authorization.allowed) {
        return reply.code(403).send({ error: authorization.reason });
      }

      const rawBody = (request.body ?? {}).body;
      if (typeof rawBody !== "string") {
        return reply.code(400).send({ error: "INVALID_CHAT_MESSAGE", message: "body is required" });
      }

      const body = sanitizeChatBody(rawBody).trim();
      if (body.length === 0) {
        return reply.code(400).send({ error: "INVALID_CHAT_MESSAGE", message: "body is required" });
      }

      const message = await fastify.gameManager.appendChat(id, principal.id, body);
      assertChatMessage(message);
      return message;
    }
  );

  // GET /tables/:id/replay - Ordered, bounded replay slice of the event log
  fastify.get<{
    Params: { id: string };
    Querystring: { fromEventSeq?: string; toEventSeq?: string };
  }>("/:id/replay", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const principal = request.principal;
    if (!principal) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const authorization = fastify.authorizeTable(
      request,
      "table:observe",
      id,
      await persistedSeatFor(fastify, id, principal)
    );
    if (!authorization.allowed) {
      return reply.code(403).send({ error: authorization.reason });
    }

    const fromEventSeq = parseRequiredInteger(request.query.fromEventSeq);
    if (fromEventSeq === undefined || fromEventSeq < 1) {
      return reply.code(400).send({
        error: "INVALID_REPLAY_RANGE",
        message: "fromEventSeq must be a positive integer",
      });
    }

    const toEventSeq = parseOptionalInteger(request.query.toEventSeq);
    if (toEventSeq !== undefined && toEventSeq < fromEventSeq) {
      return reply.code(400).send({
        error: "INVALID_REPLAY_RANGE",
        message: "toEventSeq must not precede fromEventSeq",
      });
    }

    const frame = await fastify.gameManager.replay(id, fromEventSeq, toEventSeq);
    assertReplayFrame(frame);
    return frame;
  });

  // POST /tables/:id/add-chips - Add chips to stack (rebuy/top-up)
  fastify.post<{
    Params: { id: string };
    Body: AddChipsRequest;
  }>(
    "/:id/add-chips",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const { userId } = request.user;
      const { amount, idempotencyKey } = request.body;

      if (!idempotencyKey) {
        return reply.code(400).send({ error: "idempotencyKey is required" });
      }

      const amountNum = typeof amount === "string" ? parseInt(amount, 10) : amount;
      const addChipsTable = await fastify.prisma.table.findUniqueOrThrow({
        where: { id },
        select: { config: true, mode: true },
      });
      if (addChipsTable.mode !== "CASH") {
        return reply.code(400).send({
          error: "TOURNAMENT_ADD_CHIPS_UNSUPPORTED",
          message: "Cannot add chips to tournament tables",
        });
      }
      const addChipsConfig = addChipsTable.config as { maxBuyIn?: number };
      const addChipsState = await fastify.gameManager.getState(id, userId);
      const addChipsPlayer = addChipsState.players.find((p) => p?.id === userId);

      if (!addChipsPlayer) {
        return reply.code(400).send({
          error: "NOT_SEATED",
          message: "You must be seated at the table to add chips",
        });
      }

      if (
        addChipsConfig.maxBuyIn !== undefined &&
        addChipsPlayer.stack + addChipsPlayer.pendingAddOn + amountNum > addChipsConfig.maxBuyIn
      ) {
        return reply.code(400).send({
          error: "ADD_CHIPS_ABOVE_MAXIMUM",
          message: `Stack plus pending add-ons must not exceed ${addChipsConfig.maxBuyIn}`,
        });
      }
      const risk = await fastify.riskManager.assertAllowed({
        userId,
        endpoint: "add-chips",
        request,
        chipAmount: amountNum,
      });

      const actorId = userId;
      const idem = await fastify.idempotencyManager.run({
        key: idempotencyKey,
        scope: `add-chips:${id}`,
        userId,
        requestHash: fastify.idempotencyManager.hash({ id, amount: amountNum }),
        handler: async () => {
          const table = await fastify.prisma.table.findUniqueOrThrow({
            where: { id },
            select: { config: true, mode: true },
          });
          if (table.mode !== "CASH") {
            throw Object.assign(new Error("Cannot add chips to tournament tables"), {
              statusCode: 400,
              code: "TOURNAMENT_ADD_CHIPS_UNSUPPORTED",
            });
          }
          const tableConfig = table.config as { maxBuyIn?: number };
          const lock = await fastify.redlock.lock([`lock:table:${id}`], config.TABLE_LOCK_TTL_MS);
          try {
            // Single atomic boundary: escrow the chips (or exact atomic value)
            // AND advance the engine stack in the same transaction.
            await retryTransaction(() =>
              fastify.prisma.$transaction(async (tx) => {
                const snapshot = await fastify.gameManager.loadTransactionSnapshot(tx, id);
                const player = snapshot.players.find((p) => p?.id === actorId);

                if (!player) {
                  throw Object.assign(new Error("You must be seated at the table to add chips"), {
                    statusCode: 400,
                    code: "NOT_SEATED",
                  });
                }

                if (
                  tableConfig.maxBuyIn !== undefined &&
                  player.stack + player.pendingAddOn + amountNum > tableConfig.maxBuyIn
                ) {
                  throw Object.assign(
                    new Error(`Stack plus pending add-ons must not exceed ${tableConfig.maxBuyIn}`),
                    { statusCode: 400, code: "ADD_CHIPS_ABOVE_MAXIMUM" }
                  );
                }

                await fastify.financialManager.applyBuyIn(tx, actorId, id, BigInt(amountNum), {
                  idempotencyKey,
                });
                await fastify.gameManager.applyManagementMutationInTx(tx, id, actorId, {
                  type: "ADD_CHIPS" as ActionType.ADD_CHIPS,
                  playerId: actorId,
                  amount: amountNum,
                });
              })
            );

            await fastify.gameManager.publishCommitted(id);
            return { success: true };
          } finally {
            await lock.unlock();
          }
        },
      });

      if (idem.replayed) {
        fastify.observabilityManager.increment("pokertools_idempotency_hits_total", {
          scope: "add-chips",
        });
      }
      await fastify.auditManager.record({
        actorId: userId,
        action: "ADD_CHIPS",
        resource: `table:${id}`,
        request,
        riskScore: risk.score,
        metadata: { amount: amountNum, replayed: idem.replayed },
      });
      return idem.response;
    }
  );

  // POST /tables/:id/stand - Leave table
  fastify.post<{ Params: { id: string } }>(
    "/:id/stand",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const { userId } = request.user;
      const actorId = userId;

      // Competition rosters are platform-managed: a voluntary stand could
      // corrupt the authoritative roster/elimination record.
      const competitionManaged = await competitionManagedTableError(fastify, id);
      if (competitionManaged) {
        return reply.code(competitionManaged.statusCode).send({
          error: competitionManaged.code,
          message: competitionManaged.message,
        });
      }

      // Use the same table lock namespace as game actions/settlement so engine
      // state reads, settlement flush and financial writes are serialized for
      // the table (a concurrent settle-hand/next-hand worker takes the same key).
      const lock = await fastify.redlock.lock([`lock:table:${id}`], config.TABLE_LOCK_TTL_MS * 3);

      try {
        const table = await fastify.prisma.table.findUniqueOrThrow({
          where: { id },
          select: { mode: true },
        });
        const houseUserId = table.mode === "CASH" ? await getHouseUserId(fastify.prisma) : null;

        // One atomic boundary: flush every durable settle-hand intent first so
        // the reserve already reflects the settled engine stack, then sync and
        // release the reserve, then apply the engine STAND (CAS/version/events/
        // outbox). Any failure rolls back the financial and game mutations
        // together, so a version race can never lose chips or pay a hand twice.
        await retryTransaction(() =>
          fastify.prisma.$transaction(async (tx) => {
            const snapshot = await fastify.gameManager.loadTransactionSnapshot(tx, id);
            const player = snapshot.players.find((p) => p?.id === actorId);
            if (!player) {
              throw Object.assign(new Error("Not seated at this table"), {
                statusCode: 400,
                code: "NOT_SEATED",
              });
            }

            if (table.mode === "CASH" && houseUserId) {
              // Deliver pending settle-hand payloads before crediting/cashing
              // out: a later worker settlement of the same hand is an idempotent
              // no-op and can never double-pay.
              await fastify.financialManager.flushPendingTableSettlements(tx, id, houseUserId);
              await fastify.financialManager.applyTableReserveSync(
                tx,
                actorId,
                id,
                BigInt(player.stack),
                { referenceId: id, idempotencyKey: `stand-sync:${id}:${actorId}` }
              );
              await fastify.financialManager.applyResidualReserveRelease(tx, actorId, id, {
                referenceId: id,
                idempotencyKey: `stand-cashout:${id}:${actorId}`,
              });
            }

            await fastify.gameManager.applyManagementMutationInTx(tx, id, actorId, {
              type: "STAND" as ActionType.STAND,
              playerId: actorId,
            });
          })
        );

        await fastify.gameManager.publishCommitted(id);
        return { success: true };
      } finally {
        await lock.unlock();
      }
    }
  );
};
