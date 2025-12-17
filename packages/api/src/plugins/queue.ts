import fp from "fastify-plugin";
import { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const queue = new Queue("poker-jobs", {
    connection: {
      host: new URL(config.REDIS_URL).hostname,
      port: parseInt(new URL(config.REDIS_URL).port || "6379"),
    },
  });

  fastify.decorate("queue", queue);
  fastify.log.info("BullMQ queue initialized");

  // Cleanup on shutdown
  fastify.addHook("onClose", async (app) => {
    await app.queue.close();
    fastify.log.info("BullMQ queue closed");
  });

  // Note: Function is async to support potential future async initialization
  return Promise.resolve();
};

export default fp(queuePlugin, {
  name: "queue",
  dependencies: ["redis"],
});
