import pino from "pino";
import { config } from "./config.js";
import { createPrismaClient } from "./utils/prisma-client.js";
import { buildCustodyRuntime } from "./runtime.js";

/**
 * Private withdrawal-worker entrypoint. No public HTTP or gameplay authority.
 */
const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

function main(): void {
  logger.info("Starting custody worker...");

  const prisma = createPrismaClient({
    log: [{ emit: "stdout", level: "error" }],
  });

  void buildCustodyRuntime({
    prisma,
    logger,
    config: {
      databaseUrl: config.DATABASE_URL,
      workerIntervalMs: config.CUSTODY_WORKER_INTERVAL_MS,
      reconcileIntervalMs: config.CUSTODY_RECONCILE_INTERVAL_MS,
      quorumThreshold: config.CUSTODY_QUORUM_THRESHOLD,
      minQuorum: config.CUSTODY_MIN_QUORUM,
      treasurySigningKeysJson: config.TREASURY_SIGNING_KEYS_JSON,
    },
  })
    .then((runtime) => {
      runtime.worker.start();

      const shutdown = (signal: string) => {
        logger.info({ signal }, "Shutting down custody worker...");
        runtime.worker.stop();
        void prisma.$disconnect().finally(() => process.exit(0));
      };

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to start custody worker"
      );
      process.exit(1);
    });
}

void main();
