import type { FastifyPluginAsync } from "fastify";
import type { Action } from "@pokertools/engine";
import {
  ActionType,
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

      // If client provides 'since' version, check if state is stale
      if (since !== undefined) {
        const sinceVersion = parseInt(since, 10);
        if (!isNaN(sinceVersion) && state.version <= sinceVersion) {
          // Client is up-to-date, return 304 Not Modified
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

      // Check idempotency cache (fast path)
      const lockKey = `idempotency:buyin:${userId}:${id}:${seat}`;
      const resultKey = `idempotency:result:${lockKey}`;

      const cached = await fastify.redis.get(resultKey);
      if (cached) {
        fastify.log.info(`Buy-in idempotency hit for ${userId} at table ${id}`);
        return JSON.parse(cached);
      }

      // Use short lock just to set processing flag
      const processingKey = `${resultKey}:processing`;
      const wasProcessing = await fastify.redis.set(processingKey, "1", "EX", 30, "NX");

      if (!wasProcessing) {
        // Another request is processing this - wait briefly and check result
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await fastify.redis.get(resultKey);
        if (result) {
          return JSON.parse(result);
        }
        // Fall through to process (other request may have failed)
      }

      try {
        // Financial transaction (ensure amount is a number)
        const amountNum = typeof amount === "string" ? parseInt(amount, 10) : amount;
        await fastify.financialManager.buyIn(userId, id, amountNum);

        // Get username
        const user = await fastify.prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { username: true },
        });

        // Game action (this acquires its own lock internally)
        await fastify.gameManager.processAction(
          id,
          {
            type: ActionType.SIT,
            playerId: userId,
            playerName: user.username,
            seat,
            stack: amountNum,
          },
          userId
        );

        const response = { success: true };
        await fastify.redis.set(resultKey, JSON.stringify(response), "EX", 86400);
        return response;
      } catch (err: unknown) {
        // If seat is occupied, player may have already bought in - check state
        if (err && typeof err === "object" && "code" in err && err.code === "SEAT_OCCUPIED") {
          const state = await fastify.gameManager.getState(id);
          const player = state.players[seat];

          // If this user is already in this seat, treat as success (idempotent)
          if (player && player.id === userId) {
            const response = { success: true };
            await fastify.redis.set(resultKey, JSON.stringify(response), "EX", 86400);
            return response;
          }
        }
        throw err;
      } finally {
        // Clean up processing flag
        await fastify.redis.del(processingKey);
      }
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
      const { type, amount } = request.body;

      // SECURITY: Whitelist only gameplay actions
      // Management actions (SIT, ADD_CHIPS, RESERVE_SEAT) must go through dedicated endpoints with financial checks
      // Whitelist is defined in @pokertools/types to ensure it stays in sync with engine action types
      if (!isAllowedGameplayAction(type as ActionType)) {
        return reply.code(403).send({
          error: "INVALID_ACTION",
          message: `Action type '${type}' is not allowed through this endpoint. Use dedicated endpoints for management actions.`,
        });
      }

      try {
        const state = await fastify.gameManager.processAction(
          id,
          {
            type,
            playerId: userId,
            amount: amount ? Number(amount) : undefined,
          } as Action,
          userId
        );
        return { state };
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

      // Check idempotency cache
      const lockKey = `idempotency:addchips:${userId}:${id}`;
      const resultKey = `idempotency:result:${lockKey}`;

      const cached = await fastify.redis.get(resultKey);
      if (cached) {
        fastify.log.info(`Add chips idempotency hit for ${userId} at table ${id}`);
        return JSON.parse(cached);
      }

      const processingKey = `${resultKey}:processing`;
      const wasProcessing = await fastify.redis.set(processingKey, "1", "EX", 30, "NX");

      if (!wasProcessing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await fastify.redis.get(resultKey);
        if (result) {
          return JSON.parse(result);
        }
      }

      try {
        // Verify player is seated at table
        const state = await fastify.gameManager.getState(id, userId);
        const player = state.players.find((p) => p?.id === userId);

        if (!player) {
          return reply
            .code(400)
            .send({ error: "NOT_SEATED", message: "You must be seated at the table to add chips" });
        }

        // Financial transaction (debit from MAIN, credit to IN_PLAY)
        const amountNum = typeof amount === "string" ? parseInt(amount, 10) : amount;
        await fastify.financialManager.buyIn(userId, id, amountNum);

        // Game action (adds to pendingAddOn)
        await fastify.gameManager.processAction(
          id,
          {
            type: ActionType.ADD_CHIPS,
            playerId: userId,
            amount: amountNum,
          },
          userId
        );

        const response = { success: true };
        await fastify.redis.set(resultKey, JSON.stringify(response), "EX", 86400);
        return response;
      } catch (err: unknown) {
        throw err;
      } finally {
        await fastify.redis.del(processingKey);
      }
    }
  );

  // POST /tables/:id/stand - Leave table
  fastify.post<{ Params: { id: string } }>(
    "/:id/stand",
    { onRequest: [fastify.authenticate] },
    async (request) => {
      const { id } = request.params;
      const { userId } = request.user;

      // Lock to prevent race condition
      const lock = await fastify.redlock.acquire([`lock:table:${id}:stand`], 5000);

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
            // First, sync the IN_PLAY balance to match engine reality
            // If IN_PLAY > stack, player lost chips (deduct the loss)
            // If IN_PLAY < stack, player won chips (add the win)
            const delta = stack - currentInPlay;

            if (delta !== 0) {
              // Manually sync the balance before cash-out
              // This handles the case where settle-hand worker hasn't run
              const syncAmount = Math.abs(delta);

              if (delta < 0) {
                // Player lost chips, deduct from IN_PLAY
                await fastify.prisma.account.update({
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
                // Player won chips, add to IN_PLAY
                await fastify.prisma.account.update({
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

            // Now cash out the full stack amount
            await fastify.financialManager.cashOut(userId, id, stack);
          } catch (cashOutError) {
            // If cash out fails, player keeps their chips in-game
            console.error(`❌ Cash out failed for ${userId}:`, cashOutError);
            throw new Error("Cash out failed. Please try again.");
          }
        } else if (currentInPlay > 0) {
          // Player is busted (stack = 0) but still has IN_PLAY balance
          // This means they lost all their chips, sync IN_PLAY to 0
          await fastify.prisma.account.update({
            where: {
              userId_currency_type: {
                userId,
                currency: "USDC",
                type: "IN_PLAY",
              },
            },
            data: { balance: 0 },
          });
        }

        // Only remove from table after successful cash out
        await fastify.gameManager.processAction(
          id,
          { type: ActionType.STAND, playerId: userId },
          userId
        );

        return { success: true };
      } finally {
        await lock.release();
      }
    }
  );
};
