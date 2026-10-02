import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  CreateCompetitionRequestSchema,
  IssueAgentCredentialRequestSchema,
  OptInCompetitionRequestSchema,
  SettleCompetitionRequestSchema,
  StartCompetitionRequestSchema,
} from "@pokertools/types";
import {
  assertCompetitionOwner,
  createCompetition,
  getCompetition,
  issueAgentCredential,
  optInCompetition,
  reconcileCompetition,
  settleCompetition,
  startCompetition,
} from "../../services/competition-manager.js";
import type { AuthenticatedPrincipal } from "../../services/principal-manager.js";

/**
 * Generic competition routes.
 *
 * Provider-agnostic: the platform owns authoritative seats, roster integrity,
 * explicit ASSET journals and credential confinement; external orchestrators
 * configure the roster and economics through these endpoints.
 *
 * Authorization:
 * - an ADMIN wallet or a SERVICE credential holding `competition:orchestrate`
 *   may create/start/settle/issue agent credentials, and only for the
 *   competitions it organizes (an ADMIN wallet may manage any);
 * - a configured WALLET entry payer opts in through its authenticated wallet
 *   session only; SERVICE principals are always zero-entry.
 *
 * Table-scoped agent credentials never reach these routes: the global SERVICE
 * boundary in `app.ts` requires `competition:orchestrate` for every
 * `/competitions` route.
 */

export const competitionRoutes: FastifyPluginAsync = async (fastify) => {
  // Local error mapping for this new surface only: route/finance/service errors
  // must return the stable `{error, message}` envelope regardless of Fastify
  // encapsulation. Existing platform routes keep their current handlers.
  fastify.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    // Intentional public 5xx codes (readiness/disabled) carry a code; unknown
    // failures never leak internals.
    if (statusCode >= 500 && typeof err.code !== "string") {
      return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error" });
    }
    return reply
      .code(statusCode)
      .send({ error: err.code ?? "REQUEST_REJECTED", message: err.message });
  });

  const rejectInvalid = (reply: FastifyReply, issues: unknown) =>
    reply.code(400).send({ error: "VALIDATION_FAILED", issues });

  const authorize = (
    principal: AuthenticatedPrincipal | undefined,
    reply: FastifyReply
  ): principal is AuthenticatedPrincipal => {
    const authorization = fastify.principalManager.authorizeOrchestration(principal);
    if (!authorization.allowed) {
      void reply.code(403).send({ error: "COMPETITION_ORCHESTRATION_REQUIRED" });
      return false;
    }
    return true;
  };

  fastify.post("/", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const principal = request.principal;
    if (!authorize(principal, reply)) return reply;
    const parsed = CreateCompetitionRequestSchema.safeParse(request.body);
    if (!parsed.success) return rejectInvalid(reply, parsed.error.issues);
    const result = await createCompetition(fastify, {
      organizer: principal,
      request: parsed.data,
    });
    return reply.code(201).send({
      success: true,
      competition: result.competition,
      replayed: result.replayed,
    });
  });

  fastify.get<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) return reply.code(401).send({ error: "Unauthorized" });
      const competition = await getCompetition(fastify, request.params.id);
      if (principal.kind === "SERVICE") {
        // Agents observe/act through table-scoped credentials, never here.
        if (!authorize(principal, reply)) return reply;
        assertCompetitionOwner(principal, {
          organizerId: competition.organizerPrincipalId,
        });
      }
      return { competition };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/opt-in",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) return reply.code(401).send({ error: "Unauthorized" });
      if (principal.kind !== "WALLET") {
        return reply.code(403).send({ error: "COMPETITION_WALLET_REQUIRED" });
      }
      const parsed = OptInCompetitionRequestSchema.safeParse(request.body);
      if (!parsed.success) return rejectInvalid(reply, parsed.error.issues);
      return optInCompetition(fastify, {
        competitionId: request.params.id,
        principalId: principal.id,
        idempotencyKey: parsed.data.idempotencyKey,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/start",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      const parsed = StartCompetitionRequestSchema.safeParse(request.body);
      if (!parsed.success) return rejectInvalid(reply, parsed.error.issues);
      return startCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
        idempotencyKey: parsed.data.idempotencyKey,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/reconcile",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      return reconcileCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/settle",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      const parsed = SettleCompetitionRequestSchema.safeParse(request.body);
      if (!parsed.success) return rejectInvalid(reply, parsed.error.issues);
      return settleCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
        idempotencyKey: parsed.data.idempotencyKey,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/agent-credentials",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      const parsed = IssueAgentCredentialRequestSchema.safeParse(request.body);
      if (!parsed.success) return rejectInvalid(reply, parsed.error.issues);
      const issued = await issueAgentCredential(fastify, {
        competitionId: request.params.id,
        actor: principal,
        principalId: parsed.data.principalId,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        seat: parsed.data.seat,
        expiresAt: parsed.data.expiresAt,
        credentialId: parsed.data.credentialId,
      });
      return reply.code(parsed.data.credentialId ? 200 : 201).send(issued);
    }
  );
};
