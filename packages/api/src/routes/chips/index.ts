import type { FastifyPluginAsync } from "fastify";
import { GrantChipsRequestSchema, GrantChipsResponseSchema } from "@pokertools/types";

/**
 * Operator chip-grant route.
 *
 * PLAY_CHIPS accounts are funded only by explicit operator grants. Registered
 * under `/chips`; gameplay credentials cannot mint balances.
 */

export const chipRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/grant",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsed = GrantChipsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_GRANT", issues: parsed.error.issues });
      }
      const { principalId, amount, reason, idempotencyKey } = parsed.data;

      const target = await fastify.prisma.user.findUnique({
        where: { id: principalId },
        select: { id: true },
      });
      if (!target) {
        return reply.code(404).send({ error: "PRINCIPAL_NOT_FOUND" });
      }

      const result = await fastify.financialManager.grantChips(principalId, BigInt(amount), {
        reason,
        operatorId: request.user.userId,
        idempotencyKey,
      });

      await fastify.auditManager.record({
        actorId: request.user.userId,
        action: "CHIP_GRANT",
        resource: `principal:${principalId}`,
        request,
        metadata: { amount: amount.toString(), reason, replayed: result.replayed },
      });

      return GrantChipsResponseSchema.parse({
        success: true,
        grantId: result.grantId,
        replayed: result.replayed,
        entryId: result.entry.entryId,
        balanceAfter: result.entry.balanceAfter.toString(),
      });
    }
  );
};
