import type { FastifyPluginAsync } from "fastify";
import type { Action } from "@pokertools/engine";
import type { ActionType } from "@pokertools/types";
import {
  isAllowedGameplayAction,
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  GameActionRequest,
} from "@pokertools/types";

export const tableRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /tables - List active tables
  fastify.get("/", async () => {
    const tables = await fastify.prisma.table.findMany({
      where: {
        status: { in: ["WAITING", "ACTIVE"] },
        mode: "CASH",
      },
      select: {
        id: true,
        name: true,
        config: true,
        status: true,
      },
      take: 50,
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

      return { state };
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

      const amountNum = typeof amount === "string" ? parseInt(amount, 10) : amount;
      const risk = await fastify.riskManager.assertAllowed({
        userId,
        endpoint: "buy-in",
        request,
        amountCents: amountNum,
      });

      const idem = await fastify.idempotencyManager.run({
        key: idempotencyKey,
        scope: `buy-in:${id}`,
        userId,
        requestHash: fastify.idempotencyManager.hash({ id, amount: amountNum, seat }),
        handler: async () => {
          const state = await fastify.gameManager.getState(id);
          const seatedPlayer = state.players[seat];

          if (seatedPlayer) {
            if (seatedPlayer.id === userId) return { success: true };
            throw Object.assign(new Error(`Seat ${seat} is already occupied`), {
              statusCode: 400,
              code: "SEAT_OCCUPIED",
            });
          }

          await fastify.financialManager.buyIn(userId, id, amountNum);
          const user = await fastify.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: { username: true },
          });

          await fastify.gameManager.processAction(
            id,
            {
              type: "SIT" as ActionType.SIT,
              playerId: userId,
              playerName: user.username,
              seat,
              stack: amountNum,
            },
            userId
          );
          return { success: true };
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

  // POST /tables/:id/action - Execute game action
  fastify.post<{
    Params: { id: string };
    Body: GameActionRequest;
  }>(
    "/:id/action",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params;
      const { userId } = request.user;
      const { type, amount, idempotencyKey } = request.body;

      // SECURITY: Whitelist only gameplay actions
      // Management actions (SIT, ADD_CHIPS, RESERVE_SEAT) must go through dedicated endpoints with financial checks
      // Whitelist is defined in @pokertools/types to ensure it stays in sync with engine action types
      if (!isAllowedGameplayAction(type as ActionType)) {
        return reply.code(403).send({
          error: "INVALID_ACTION",
          message: `Action type '${type}' is not allowed through this endpoint. Use dedicated endpoints for management actions.`,
        });
      }

      const runAction = async () => {
        const state = await fastify.gameManager.processAction(
          id,
          {
            type,
            playerId: userId,
            amount: amount ? Number(amount) : undefined,
          } as Action,
          userId
        );
        fastify.observabilityManager.increment("pokertools_game_actions_total", { type });
        await fastify.auditManager.record({
          actorId: userId,
          action: `GAME_${type}`,
          resource: `table:${id}`,
          request,
          metadata: { amount },
        });
        return { state };
      };

      try {
        if (idempotencyKey) {
          const idem = await fastify.idempotencyManager.run({
            key: idempotencyKey,
            scope: `game-action:${id}`,
            userId,
            requestHash: fastify.idempotencyManager.hash({ id, type, amount }),
            ttlSeconds: 3600,
            handler: runAction,
          });
          if (idem.replayed) {
            fastify.observabilityManager.increment("pokertools_idempotency_hits_total", {
              scope: "game-action",
            });
          }
          return idem.response;
        }
        return await runAction();
      } catch (err: unknown) {
        // Map engine errors to HTTP 400
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
      const risk = await fastify.riskManager.assertAllowed({
        userId,
        endpoint: "add-chips",
        request,
        amountCents: amountNum,
      });

      const idem = await fastify.idempotencyManager.run({
        key: idempotencyKey,
        scope: `add-chips:${id}`,
        userId,
        requestHash: fastify.idempotencyManager.hash({ id, amount: amountNum }),
        handler: async () => {
          // Verify player is seated at table
          const state = await fastify.gameManager.getState(id, userId);
          const player = state.players.find((p) => p?.id === userId);

          if (!player) {
            throw Object.assign(new Error("You must be seated at the table to add chips"), {
              statusCode: 400,
              code: "NOT_SEATED",
            });
          }

          // Financial transaction (debit from MAIN, credit to IN_PLAY)
          await fastify.financialManager.buyIn(userId, id, amountNum);

          // Game action (adds to pendingAddOn)
          await fastify.gameManager.processAction(
            id,
            {
              type: "ADD_CHIPS" as ActionType.ADD_CHIPS,
              playerId: userId,
              amount: amountNum,
            },
            userId
          );

          return { success: true };
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
    async (request) => {
      const { id } = request.params;
      const { userId } = request.user;

      // Use the same table lock namespace as game actions/settlement so engine
      // state reads and financial writes are serialized for the table.
      const lock = await fastify.redlock.acquire([`lock:table:${id}`], 5000);

      try {
        const state = await fastify.gameManager.getState(id);
        const player = state.players.find((p) => p?.id === userId);

        if (!player) {
          throw new Error("Not seated at this table");
        }

        const stack = player.stack;

        // Get current IN_PLAY balance to calculate the delta
        const balances = await fastify.financialManager.getBalances(userId);
        const currentInPlay = balances.inPlay;

        // CRITICAL: Cash out based on actual stack, not IN_PLAY balance
        // The settle-hand worker may not have run yet, so IN_PLAY might be stale
        // We need to settle up the difference between current IN_PLAY and engine stack
        if (stack > 0) {
          try {
            await fastify.prisma.$transaction(async (tx) => {
              // First, sync the IN_PLAY balance to match engine reality
              const delta = stack - currentInPlay;

              if (delta !== 0) {
                const syncAmount = Math.abs(delta);
                const inPlayAccount = await tx.account.findUniqueOrThrow({
                  where: {
                    userId_currency_type: {
                      userId,
                      currency: "USDC",
                      type: "IN_PLAY",
                    },
                  },
                });

                await tx.ledgerEntry.create({
                  data: {
                    accountId: inPlayAccount.id,
                    amount: delta,
                    type: delta > 0 ? "HAND_WIN" : "HAND_LOSS",
                    referenceId: id,
                    metadata: { reason: "stand_engine_stack_sync", tableId: id },
                  },
                });

                if (delta < 0) {
                  await tx.account.update({
                    where: {
                      userId_currency_type: {
                        userId,
                        currency: "USDC",
                        type: "IN_PLAY",
                      },
                    },
                    data: { balance: { decrement: syncAmount } },
                  });
                } else {
                  await tx.account.update({
                    where: {
                      userId_currency_type: {
                        userId,
                        currency: "USDC",
                        type: "IN_PLAY",
                      },
                    },
                    data: { balance: { increment: syncAmount } },
                  });
                }
              }

              // Cash out: move IN_PLAY -> MAIN with ledger entries
              const inPlayAccount = await tx.account.findUniqueOrThrow({
                where: {
                  userId_currency_type: {
                    userId,
                    currency: "USDC",
                    type: "IN_PLAY",
                  },
                },
              });

              const mainAccount = await tx.account.findUniqueOrThrow({
                where: {
                  userId_currency_type: {
                    userId,
                    currency: "USDC",
                    type: "MAIN",
                  },
                },
              });

              await tx.ledgerEntry.createMany({
                data: [
                  {
                    accountId: inPlayAccount.id,
                    amount: -stack,
                    type: "CASH_OUT",
                    referenceId: id,
                  },
                  {
                    accountId: mainAccount.id,
                    amount: stack,
                    type: "CASH_OUT",
                    referenceId: id,
                  },
                ],
              });

              await tx.account.update({
                where: { id: inPlayAccount.id },
                data: { balance: { decrement: stack } },
              });

              await tx.account.update({
                where: { id: mainAccount.id },
                data: { balance: { increment: stack } },
              });
            });
          } catch (cashOutError) {
            fastify.log.error({ userId, error: cashOutError }, "Cash out failed");
            throw new Error("Cash out failed. Please try again.", { cause: cashOutError });
          }
        } else if (currentInPlay > 0) {
          // Player is busted (stack = 0) but still has IN_PLAY balance
          // This means they lost all their chips, sync IN_PLAY to 0
          await fastify.prisma.$transaction(async (tx) => {
            const inPlayAccount = await tx.account.findUniqueOrThrow({
              where: {
                userId_currency_type: {
                  userId,
                  currency: "USDC",
                  type: "IN_PLAY",
                },
              },
            });
            await tx.ledgerEntry.create({
              data: {
                accountId: inPlayAccount.id,
                amount: -currentInPlay,
                type: "HAND_LOSS",
                referenceId: id,
                metadata: { reason: "stand_busted_sync", tableId: id },
              },
            });
            await tx.account.update({
              where: { id: inPlayAccount.id },
              data: { balance: 0 },
            });
          });
        }

        // Only remove from table after successful cash out
        await fastify.gameManager.processAction(
          id,
          { type: "STAND" as ActionType.STAND, playerId: userId },
          userId,
          { skipLock: true }
        );

        return { success: true };
      } finally {
        await lock.release();
      }
    }
  );
};
