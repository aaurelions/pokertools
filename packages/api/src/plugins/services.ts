import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { GameManager } from "../services/game-manager.js";
import { FinancialManager } from "../services/financial-manager.js";
import { SocketManager } from "../services/socket-manager.js";
import { BlockchainManager } from "../services/blockchain-manager.js";
import { NotesManager } from "../services/notes-manager.js";
import { ObservabilityManager } from "../services/observability-manager.js";
import { AuditManager } from "../services/audit-manager.js";
import { RiskManager } from "../services/risk-manager.js";
import { IdempotencyManager } from "../services/idempotency-manager.js";

const servicesPlugin: FastifyPluginAsync = async (fastify) => {
  // The decorated properties (redis, redlock, queue, prisma) are typed in fastify.d.ts,
  // but TypeScript doesn't recognize them in plugin context before decoration.
  // This is a known limitation of Fastify's plugin system.
  const gameManager = new GameManager(
    fastify.redis,
    fastify.redlock,
    fastify.queue,
    fastify.prisma
  );

  const financialManager = new FinancialManager(fastify.prisma);
  const blockchainManager = new BlockchainManager(fastify.prisma);
  const notesManager = new NotesManager(fastify.prisma);
  const observabilityManager = new ObservabilityManager(fastify);
  const auditManager = new AuditManager(fastify.prisma, observabilityManager);
  const riskManager = new RiskManager(fastify.redis);
  const idempotencyManager = new IdempotencyManager(fastify.prisma);

  const socketManager = new SocketManager(fastify);

  fastify.decorate("gameManager", gameManager);
  fastify.decorate("financialManager", financialManager);
  fastify.decorate("socketManager", socketManager);
  fastify.decorate("blockchainManager", blockchainManager);
  fastify.decorate("notesManager", notesManager);
  fastify.decorate("observabilityManager", observabilityManager);
  fastify.decorate("auditManager", auditManager);
  fastify.decorate("riskManager", riskManager);
  fastify.decorate("idempotencyManager", idempotencyManager);

  observabilityManager.attachHttpMetrics();

  fastify.log.info("Services initialized");

  await Promise.resolve();
};

export default fp(servicesPlugin, {
  name: "services",
  dependencies: ["prisma", "redis", "redlock", "queue"],
});
