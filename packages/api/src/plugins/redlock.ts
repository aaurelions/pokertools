import fp from "fastify-plugin";
import Redlock from "redlock";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";

const redlockPlugin: FastifyPluginAsync = async (fastify) => {
  const isTestEnv = config.NODE_ENV === "test";

  const redlock = new Redlock([fastify.redis], {
    driftFactor: config.REDLOCK_DRIFT_FACTOR,
    retryCount: isTestEnv ? config.REDLOCK_RETRY_COUNT_TEST : config.REDLOCK_RETRY_COUNT,
    retryDelay: isTestEnv ? config.REDLOCK_RETRY_DELAY_MS_TEST : config.REDLOCK_RETRY_DELAY_MS,
    retryJitter: isTestEnv ? config.REDLOCK_RETRY_JITTER_MS_TEST : config.REDLOCK_RETRY_JITTER_MS,
    automaticExtensionThreshold: config.REDLOCK_AUTOMATIC_EXTENSION_THRESHOLD_MS,
  });

  redlock.on("error", (error) => {
    // Ignore cases where a resource is locked (normal operation)
    if (error instanceof Error && !error.message.includes("failed to acquire")) {
      fastify.log.warn(error.message);
    }
  });

  fastify.decorate("redlock", redlock);
  fastify.log.info("Redlock initialized");

  await Promise.resolve();
};

export default fp(redlockPlugin, {
  name: "redlock",
  dependencies: ["redis"],
});
