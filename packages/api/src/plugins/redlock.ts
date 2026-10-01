import fp from "fastify-plugin";
import Redlock from "redlock";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";

const redlockPlugin: FastifyPluginAsync = async (fastify) => {
  const isTestEnv = config.NODE_ENV === "test";

  // Redlock's typings describe array-form eval; ioredis accepts it at runtime.
  const redlock = new Redlock([fastify.redis as unknown as Redlock.CompatibleRedisClient], {
    driftFactor: config.REDLOCK_DRIFT_FACTOR,
    retryCount: isTestEnv ? config.REDLOCK_RETRY_COUNT_TEST : config.REDLOCK_RETRY_COUNT,
    retryDelay: isTestEnv ? config.REDLOCK_RETRY_DELAY_MS_TEST : config.REDLOCK_RETRY_DELAY_MS,
    retryJitter: isTestEnv ? config.REDLOCK_RETRY_JITTER_MS_TEST : config.REDLOCK_RETRY_JITTER_MS,
  });

  redlock.on("clientError", () => {
    fastify.log.warn("Redis lock client failed");
  });

  fastify.decorate("redlock", redlock);
  fastify.log.info("Redlock initialized");

  await Promise.resolve();
};

export default fp(redlockPlugin, {
  name: "redlock",
  dependencies: ["redis"],
});
