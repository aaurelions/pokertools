import { describe, expect, it, vi } from "vitest";
import {
  dispatchOutboxRow,
  durableOutboxProcessor,
  recoverGameOutbox,
} from "../../src/services/game-outbox.js";

function fixture(kind = "settle-hand") {
  const row = {
    id: "outbox-safe-id",
    tableId: "table",
    kind,
    dedupeKey: `${kind}:table:1`,
    payload: { tableId: "table", expectedVersion: 1 },
    status: "DISPATCHED",
    attempts: 1,
    availableAt: new Date(0),
  };
  const update = vi.fn(async ({ data }) => {
    Object.assign(row, data);
    return row;
  });
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.status === "FAILED") return { count: 0 };
    if (typeof where.status === "string" && where.status !== row.status) return { count: 0 };
    if (data.status) row.status = data.status;
    if (data.attempts) row.attempts += data.attempts.increment;
    return { count: 1 };
  });
  const prisma = {
    gameOutbox: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async ({ where }) =>
        where.status === row.status && (!where.id?.gt || row.id > where.id.gt) ? [row] : []
      ),
      update,
      updateMany,
    },
    table: { findUnique: vi.fn(async () => ({ stateVersion: 1, status: "ACTIVE" })) },
  };
  const queue = {
    add: vi.fn(async () => undefined),
    getJob: vi.fn(async () => undefined as unknown),
  };
  const queues = {
    "settle-hand": queue,
    "archive-hand": queue,
    "next-hand": queue,
    "player-timeout": queue,
  };
  const redis = { publish: vi.fn(async () => 1) };
  return { row, prisma, queue, queues, redis };
}

describe("durable outbox processing", () => {
  it("uses a stable colon-free row id and preserves the future queue deadline", async () => {
    const h = fixture("player-timeout");
    h.row.availableAt = new Date(Date.now() + 60_000);
    await dispatchOutboxRow(h.prisma as never, h.queues as never, h.redis as never, h.row);
    const options = h.queue.add.mock.calls[0][2] as { jobId: string; delay: number };
    expect(options.jobId).toBe(h.row.id);
    expect(options.jobId).not.toContain(":");
    expect(options.delay).toBeGreaterThan(59_000);
  });

  it("executes only the committed payload, acknowledges after success, and refuses early execution", async () => {
    const h = fixture();
    const execute = vi.fn(async () => {
      expect(h.prisma.gameOutbox.update).not.toHaveBeenCalled();
    });
    const processor = durableOutboxProcessor(h.prisma as never, "settle-hand", execute);
    const job = { id: h.row.id, data: { tableId: "spoofed-table" } };
    h.row.availableAt = new Date(Date.now() + 60_000);
    await expect(processor(job as never)).rejects.toThrow("Outbox deadline has not elapsed");
    expect(execute).not.toHaveBeenCalled();
    h.row.availableAt = new Date(0);
    await processor(job as never);
    expect(execute).toHaveBeenCalledWith(h.row.payload);
    expect(h.row.status).toBe("COMPLETED");
    await processor(job as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a failed handler or accept an intent from another queue", async () => {
    const h = fixture();
    const job = { id: h.row.id };
    const processor = durableOutboxProcessor(h.prisma as never, "settle-hand", async () => {
      throw new Error("handler failed");
    });
    await expect(processor(job as never)).rejects.toThrow("handler failed");
    expect(h.row.status).toBe("DISPATCHED");
    expect(h.prisma.gameOutbox.update).not.toHaveBeenCalled();
    h.row.kind = "archive-hand";
    await expect(processor(job as never)).rejects.toThrow("committed outbox intent");
  });

  it("restores a dispatched but lost settlement job from its durable payload", async () => {
    const h = fixture();
    await recoverGameOutbox(h.prisma as never, h.queues as never, h.redis as never);
    expect(h.queue.add).toHaveBeenCalledWith(
      "settle-hand",
      h.row.payload,
      expect.objectContaining({ jobId: h.row.id })
    );
    expect(h.row.status).toBe("DISPATCHED");
  });

  it("retires stale timeout versions without executing them", async () => {
    const h = fixture("player-timeout");
    h.row.payload.expectedVersion = 0;
    await recoverGameOutbox(h.prisma as never, h.queues as never, h.redis as never);
    expect(h.row.status).toBe("COMPLETED");
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("acknowledges completed transport jobs and bounds exhausted handler retries", async () => {
    const h = fixture();
    h.queue.getJob.mockResolvedValue({ getState: async () => "completed" });
    await recoverGameOutbox(h.prisma as never, h.queues as never, h.redis as never);
    expect(h.row.status).toBe("COMPLETED");
    h.row.status = "DISPATCHED";
    const retry = vi.fn(async () => undefined);
    h.queue.getJob.mockResolvedValue({ getState: async () => "failed", retry });
    await recoverGameOutbox(h.prisma as never, h.queues as never, h.redis as never);
    expect(retry).toHaveBeenCalledWith("failed");
    expect(h.row.attempts).toBe(2);
    h.row.attempts = 25;
    await recoverGameOutbox(h.prisma as never, h.queues as never, h.redis as never);
    expect(h.row.status).toBe("FAILED");
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
