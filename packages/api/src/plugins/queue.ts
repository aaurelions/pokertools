import fp from "fastify-plugin";
import { Queue, type ConnectionOptions } from "bullmq";
import type { FastifyPluginAsync } from "fastify";

const jobQueueNames = [
  "settle-hand",
  "archive-hand",
  "next-hand",
  "persist-snapshot",
  "player-timeout",
  "tournament-blinds",
] as const;

export type JobQueueName = (typeof jobQueueNames)[number];
export type JobQueues = Record<JobQueueName, Queue>;

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const connection = fastify.redis as unknown as ConnectionOptions;
  const jobQueues = Object.fromEntries(
    jobQueueNames.map((name) => [
      name,
      new Queue(name, {
        connection,
        defaultJobOptions: {
          attempts: name === "settle-hand" ? 10 : 5,
          backoff: { type: "exponential", delay: 500 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    ])
  ) as JobQueues;

  fastify.decorate("queue", jobQueues["settle-hand"]);
  fastify.decorate("jobQueues", jobQueues);
  fastify.log.info({ queues: jobQueueNames }, "BullMQ queues initialized");

  fastify.addHook("onClose", async (app) => {
    await Promise.all(
      Object.values(app.jobQueues).map((queue) =>
        queue.close().catch((error: unknown) => {
          if (!(error instanceof Error) || !error.message.includes("Connection is closed")) {
            throw error;
          }
        })
      )
    );
    fastify.log.info("BullMQ queues closed");
  });

  await Promise.resolve();
};

export default fp(queuePlugin, {
  name: "queue",
  dependencies: ["redis"],
});
