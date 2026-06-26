import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { createPrismaClient } from "../utils/prisma-client.js";

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const prisma = createPrismaClient({
    log: fastify.log.level === "debug" ? ["query", "info", "warn", "error"] : ["error"],
  });

  await prisma.$connect();
  fastify.log.info("Prisma connected to database");

  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async (app: FastifyInstance) => {
    await app.prisma.$disconnect();
    fastify.log.info("Prisma disconnected");
  });
};

export default fp(prismaPlugin, {
  name: "prisma",
});
