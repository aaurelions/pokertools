import "@fastify/jwt";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { Redis } from "ioredis";
import type Redlock from "redlock";
import type { Queue } from "bullmq";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { GameManager } from "../src/services/GameManager.js";
import type { SocketManager } from "../src/services/SocketManager.js";
import type { FinancialManager } from "../src/services/FinancialManager.js";
import type { BlockchainManager } from "../src/services/BlockchainManager.js";
import type { NotesManager } from "../src/services/NotesManager.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: {
      userId: string;
      jti: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    redlock: Redlock;
    queue: Queue;
    gameManager: GameManager;
    socketManager: SocketManager;
    financialManager: FinancialManager;
    blockchainManager: BlockchainManager;
    notesManager: NotesManager;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
