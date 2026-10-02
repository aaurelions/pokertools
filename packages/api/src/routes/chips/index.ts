import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

/**
 * Operator chip-grant route.
 *
 * PLAY_CHIPS accounts are funded ONLY by an explicit operator grant. This route
 * is intentionally NOT registered in app.ts yet: the canonical API schema/type
 * surface is still converging, and the supervisor owns route registration.
 *
 * After party principals can be targeted, registering this plugin (prefix
 * `/chips`) exposes `POST /chips/grant`.
 */

const GrantChipsSchema = z
  .strictObject({
    principalId: z.string().min(1),
    // Integer chips as a non-negative safe integer. Decimal strings accepted
    // for parity with other amount wire fields.
    amount: z.union([
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      z.string().regex(/^[1-9][0-9]*$/),
    ]),
    reason: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const chipRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/grant",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsed = GrantChipsSchema.safeParse(request.body);
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

      return {
        success: true,
        grantId: result.grantId,
        replayed: result.replayed,
        entryId: result.entry.entryId,
        balanceAfter: result.entry.balanceAfter.toString(),
      };
    }
  );
};
