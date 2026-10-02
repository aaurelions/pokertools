import "@fastify/jwt";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { Queue } from "bullmq";
import type { JobQueues } from "../src/plugins/queue.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { GameManager } from "../src/services/game-manager.js";
import type { SocketManager } from "../src/services/socket-manager.js";
import type { FinancialManager } from "../src/services/financial-manager.js";
import type { NotesManager } from "../src/services/notes-manager.js";
import type { ObservabilityManager } from "../src/services/observability-manager.js";
import type { AuditManager } from "../src/services/audit-manager.js";
import type { RiskManager } from "../src/services/risk-manager.js";
import type { IdempotencyManager } from "../src/services/idempotency-manager.js";
import type {
  AuthenticatedPrincipal,
  PrincipalManager,
  TableAuthorization,
  TableScope,
} from "../src/services/principal-manager.js";
import type { IncidentReadinessCheck } from "../src/services/financial-incidents.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: {
      userId: string;
      jti: string;
      address?: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    redlock: Redlock;
    queue: Queue;
    jobQueues: JobQueues;
    gameManager: GameManager;
    socketManager: SocketManager;
    financialManager: FinancialManager;
    notesManager: NotesManager;
    observabilityManager: ObservabilityManager;
    auditManager: AuditManager;
    riskManager: RiskManager;
    idempotencyManager: IdempotencyManager;
    principalManager: PrincipalManager;
    /**
     * Optional injected fail-closed incident-resolution readiness check
     * (RPC quorum, native gas). When absent the resolve route refuses to
     * unfreeze — there is no default-success path.
     */
    financialIncidentReadinessCheck?: IncidentReadinessCheck;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOperator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorizeTable: (
      request: FastifyRequest,
      scope: TableScope,
      tableId?: string | null,
      persistedSeat?: number | null
    ) => TableAuthorization;
  }

  interface FastifyRequest {
    /** Canonical identity attached by the authenticate decorator. */
    principal?: AuthenticatedPrincipal;
  }
}
