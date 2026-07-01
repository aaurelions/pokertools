import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
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
      const account = await fastify.prisma.account.update({
        where: {
          userId_currency_type: { userId, currency: config.DEFAULT_CURRENCY, type: "MAIN" },
        },
        data: { balance: BigInt(parsed.data.amount) },
      });

      return { success: true, balance: Number(account.balance) };
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
