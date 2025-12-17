import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { GameManager } from "../services/GameManager.js";
import { FinancialManager } from "../services/FinancialManager.js";
import { SocketManager } from "../services/SocketManager.js";
import { BlockchainManager } from "../services/BlockchainManager.js";
import { NotesManager } from "../services/NotesManager.js";

const servicesPlugin: FastifyPluginAsync = async (fastify) => {
  // Initialize services
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

  const socketManager = new SocketManager(fastify);

  // Decorate fastify instance
  fastify.decorate("gameManager", gameManager);
  fastify.decorate("financialManager", financialManager);
  fastify.decorate("socketManager", socketManager);
  fastify.decorate("blockchainManager", blockchainManager);
  fastify.decorate("notesManager", notesManager);

  fastify.log.info("Services initialized");

  // Note: Function is async to support potential future async initialization
  return Promise.resolve();
};

export default fp(servicesPlugin, {
  name: "services",
  dependencies: ["prisma", "redis", "redlock", "queue"],
});
