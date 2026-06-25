import fp from "fastify-plugin";
import Redlock from "redlock";
import type { FastifyPluginAsync } from "fastify";

const redlockPlugin: FastifyPluginAsync = async (fastify) => {
  // Configure Redlock for single-instance (dev/test) or multi-instance (prod)
  const isTestEnv = process.env.NODE_ENV === "test";

  const redlock = new Redlock([fastify.redis], {
    driftFactor: 0.01,
    retryCount: isTestEnv ? 5000 : 50, // Even higher for concurrent test scenarios
    retryDelay: isTestEnv ? 2 : 100, // Very fast retry in tests
    retryJitter: isTestEnv ? 2 : 100,
    automaticExtensionThreshold: 500,
  });

  redlock.on("error", (error) => {
    // Ignore cases where a resource is locked (normal operation)
    if (error instanceof Error && !error.message.includes("failed to acquire")) {
      fastify.log.warn(error.message);
    }
  });

  fastify.decorate("redlock", redlock);
  fastify.log.info("Redlock initialized");

  // Note: Function is async to support potential future async initialization
  return Promise.resolve();
};

export default fp(redlockPlugin, {
  name: "redlock",
  dependencies: ["redis"],
});
