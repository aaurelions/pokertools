import { PrismaClient } from "../../api/generated/prisma/index.js";
import Redis from "ioredis";
import pino from "pino";
import { config } from "./config.js";
import { BlockchainService } from "./services/BlockchainService.js";
import { SweeperService } from "./services/SweeperService.js";
import { WithdrawalBot } from "./services/WithdrawalBot.js";
import { GasMonitor } from "./services/GasMonitor.js";
import { TransactionMonitor } from "./services/TransactionMonitor.js";

interface PrismaQueryEvent {
  timestamp: Date;
  query: string;
  params: string;
  duration: number;
  target: string;
}

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
  const prisma = new PrismaClient({
    log:
      config.NODE_ENV === "development"
        ? [{ emit: "event", level: "query" }]
        : [{ emit: "event", level: "error" }],
  });

  if (config.NODE_ENV === "development") {
    prisma.$on("query" as never, (e: unknown) => {
      const event = e as PrismaQueryEvent;
      logger.debug({ query: event.query, params: event.params }, "Prisma Query");
    });
  }

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
  const chainService = new BlockchainService(prisma, logger);

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

  const shutdown = () => {
    logger.info("Shutting down...");
    void prisma.$disconnect();
    void redis.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
