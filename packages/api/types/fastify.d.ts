import "@fastify/jwt";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { Queue } from "bullmq";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { GameManager } from "../src/services/game-manager.js";
import type { SocketManager } from "../src/services/socket-manager.js";
import type { FinancialManager } from "../src/services/financial-manager.js";
import type { BlockchainManager } from "../src/services/blockchain-manager.js";
import type { NotesManager } from "../src/services/notes-manager.js";
import type { ObservabilityManager } from "../src/services/observability-manager.js";
import type { AuditManager } from "../src/services/audit-manager.js";
import type { RiskManager } from "../src/services/risk-manager.js";
import type { IdempotencyManager } from "../src/services/idempotency-manager.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: {
      userId: string;
      jti: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    redlock: Redlock;
    queue: Queue;
    gameManager: GameManager;
    socketManager: SocketManager;
    financialManager: FinancialManager;
    blockchainManager: BlockchainManager;
    notesManager: NotesManager;
    observabilityManager: ObservabilityManager;
    auditManager: AuditManager;
    riskManager: RiskManager;
    idempotencyManager: IdempotencyManager;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
