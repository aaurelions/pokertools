import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";

const testCreditSchema = z.object({
  amount: z.number().int().min(0).max(1_000_000),
});

const parseStoredState = (state: unknown): unknown => {
  if (typeof state !== "string") return state;
  return JSON.parse(state) as unknown;
};

const testRoutesPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/user/test-credit",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = testCreditSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });

      const { userId } = request.user;
      await fastify.financialManager.ensureAccounts(userId);
      const result = await fastify.financialManager.grantChips(userId, parsed.data.amount, {
        reason: "test_credit",
        operatorId: userId,
        idempotencyKey: `test-credit:${userId}:${randomUUID()}`,
      });
      const balances = await fastify.financialManager.getChipBalances(userId);
      return { success: true, balance: Number(balances.available), grantId: result.grantId };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/tables/:id/test-state",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const table = await fastify.prisma.table.findUnique({
        where: { id: request.params.id },
        select: { state: true },
      });
      if (!table?.state) return reply.code(404).send({ error: "TABLE_STATE_NOT_FOUND" });
      return { state: parseStoredState(table.state) };
    }
  );

  fastify.post<{ Params: { id: string }; Body: { state?: unknown } }>(
    "/tables/:id/test-state",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (!request.body || typeof request.body.state !== "object" || request.body.state === null) {
        return reply.code(400).send({ error: "INVALID_STATE" });
      }
      const serialized = JSON.stringify(request.body.state);
      await Promise.all([
        fastify.redis.set(
          `table:${request.params.id}`,
          serialized,
          "EX",
          config.TABLE_REDIS_TTL_SECONDS
        ),
        fastify.prisma.table.update({
          where: { id: request.params.id },
          data: { state: serialized },
        }),
      ]);
      return { success: true };
    }
  );

  await Promise.resolve();
};

export default fp(testRoutesPlugin, {
  name: "test-routes",
});
