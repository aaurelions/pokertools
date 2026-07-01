import { createPrismaClient } from "./utils/prisma-client.js";
import Redis from "ioredis";
import pino from "pino";
import { config } from "./config.js";
import { BlockchainService } from "./services/blockchain-service.js";
import { SweeperService } from "./services/sweeper-service.js";
import { WithdrawalBot } from "./services/withdrawal-bot.js";
import { GasMonitor } from "./services/gas-monitor.js";
import { TransactionMonitor } from "./services/transaction-monitor.js";

const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

function main() {
  logger.info("🚀 Starting Admin Service...");

  // 1. Initialize Infrastructure
  const prisma = createPrismaClient({
    log:
      config.NODE_ENV === "development"
        ? [{ emit: "stdout", level: "query" }]
        : [{ emit: "stdout", level: "error" }],
  });

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  redis.on("error", (err) => logger.error(err, "Redis Error"));
  redis.on("connect", () => logger.info("✅ Redis Connected"));

  // 2. Initialize Services
  const chainService = new BlockchainService(prisma, logger, redis);

  const sweeper = new SweeperService(prisma, chainService, logger);
  const bot = new WithdrawalBot(prisma, redis, chainService, logger);
  const gasMonitor = new GasMonitor(prisma, chainService, bot.bot, logger);
  const txMonitor = new TransactionMonitor(prisma, chainService, logger);

  // 3. Start Event Loops
  try {
    // Start all services (fire and forget)
    void sweeper.startCron().catch((e) => logger.error(e, "Sweeper Fail"));
    gasMonitor.start();
    txMonitor.start();
    void bot.start().catch((e) => logger.error(e, "Bot Fail"));

    logger.info("✅ All services started successfully");
  } catch (error) {
    logger.fatal(error, "Startup Failed");
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info("Shutting down...");
    if (bot) await bot.stop().catch((e) => logger.error(e, "Bot stop failed"));
    void prisma.$disconnect();
    void redis.quit();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
