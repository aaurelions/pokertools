import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  CancelCompetitionRequestSchema,
  CreateCompetitionRequestSchema,
  IssueAgentCredentialRequestSchema,
  OptInCompetitionRequestSchema,
  SettleCompetitionRequestSchema,
  StartCompetitionRequestSchema,
} from "@pokertools/types";
import {
  assertCompetitionOwner,
  cancelCompetition,
  createCompetition,
  getCompetition,
  issueAgentCredential,
  optInCompetition,
  reconcileCompetition,
  settleCompetition,
  startCompetition,
} from "../../services/competition-manager.js";
import { AppError } from "../../utils/errors.js";
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
 *   may create/start/settle/cancel/issue agent credentials, and only for the
 *   competitions it organizes (an ADMIN wallet may manage any);
 * - a configured WALLET entry payer opts in through its authenticated wallet
 *   session only; SERVICE principals are always zero-entry.
 *
 * Natural idempotency: opt-in/start/settle/cancel take an empty strict body.
 * Their identity is durable state (PAID marker + exact journal, start marker,
 * settled status, cancelled status), so a stale `idempotencyKey` in the body is
 * rejected instead of ignored. Create keeps a real request idempotency key.
 *
 * Table-scoped agent credentials never reach these routes: the global SERVICE
 * boundary in `app.ts` requires `competition:orchestrate` for every
 * `/competitions` route.
 */

export const competitionRoutes: FastifyPluginAsync = async (fastify) => {
  // Local error mapping for this new surface only: route/finance/service errors
  // must return the stable `{error, message}` envelope regardless of Fastify
  // encapsulation. Only trusted domain `AppError`s may expose a code/status
  // (including deliberate public 5xx readiness/disabled codes). Unexpected
  // errors — Prisma/driver failures, even ones that carry a `code` property —
  // are sanitized so their message/credentials can never leak.
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code ?? "REQUEST_REJECTED", message: error.message });
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error" });
    }
    // Bounded Fastify client errors (body parse/validation) are safe to surface.
    const err = error as Error & { code?: string };
    return reply
      .code(statusCode)
      .send({ error: err.code ?? "REQUEST_REJECTED", message: err.message });
  });

  const rejectInvalid = (reply: FastifyReply, issues: unknown) =>
    reply.code(400).send({ error: "VALIDATION_FAILED", issues });

  // Opt-in/start/settle/cancel are naturally idempotent from durable state and
  // accept an empty strict object: an absent body is `{}`, while any present
  // key (including a stale `idempotencyKey`) is rejected, never ignored.
  const parseEmptyBody = (
    schema: typeof OptInCompetitionRequestSchema,
    body: unknown
  ): { ok: true } | { ok: false; issues: unknown } => {
    const parsed = schema.safeParse(body === undefined ? {} : body);
    return parsed.success ? { ok: true } : { ok: false, issues: parsed.error.issues };
  };

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
      const parsed = parseEmptyBody(OptInCompetitionRequestSchema, request.body);
      if (!parsed.ok) return rejectInvalid(reply, parsed.issues);
      return optInCompetition(fastify, {
        competitionId: request.params.id,
        principalId: principal.id,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/start",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      const parsed = parseEmptyBody(StartCompetitionRequestSchema, request.body);
      if (!parsed.ok) return rejectInvalid(reply, parsed.issues);
      return startCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/cancel",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = request.principal;
      if (!authorize(principal, reply)) return reply;
      const parsed = parseEmptyBody(CancelCompetitionRequestSchema, request.body);
      if (!parsed.ok) return rejectInvalid(reply, parsed.issues);
      return cancelCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
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
      const parsed = parseEmptyBody(SettleCompetitionRequestSchema, request.body);
      if (!parsed.ok) return rejectInvalid(reply, parsed.issues);
      return settleCompetition(fastify, {
        competitionId: request.params.id,
        actor: principal,
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
