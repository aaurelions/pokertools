import fp from "fastify-plugin";
import { Queue, type ConnectionOptions } from "bullmq";
import type { FastifyPluginAsync } from "fastify";

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const queue = new Queue("poker-jobs", {
    connection: fastify.redis as unknown as ConnectionOptions,
  });

  fastify.decorate("queue", queue);
  fastify.log.info("BullMQ queue initialized");

  // Cleanup on shutdown
  fastify.addHook("onClose", async (app) => {
    await app.queue.close().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
        throw error;
      }
    });
    fastify.log.info("BullMQ queue closed");
  });

  // Note: Function is async to support potential future async initialization
  return Promise.resolve();
};

export default fp(queuePlugin, {
  name: "queue",
  dependencies: ["redis"],
});
