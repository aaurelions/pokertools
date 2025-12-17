import fp from "fastify-plugin";
import Redis from "ioredis";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ compatibility
    enableReadyCheck: false,
  });

  redis.on("error", (err) => {
    fastify.log.error(err, "Redis connection error");
  });

  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => {
      fastify.log.info("Redis connected");
      resolve();
    });
    redis.once("error", reject);
  });

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async (app) => {
    await app.redis.quit();
    fastify.log.info("Redis disconnected");
  });
};

export default fp(redisPlugin, {
  name: "redis",
});
