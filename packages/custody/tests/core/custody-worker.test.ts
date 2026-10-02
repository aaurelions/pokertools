import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustodyWorker } from "../../src/workers/custody-worker.js";
import type {
  ReconciliationOutcome,
  RunSummary,
  WithdrawalWorkflow,
} from "../../src/core/withdrawal-workflow.js";
import type { CustodyHeartbeatWriter } from "../../src/workers/heartbeat-writer.js";
import type { AssetRegistry, CustodyLogger, TreasuryAsset } from "../../src/core/types.js";
import { ASSET } from "./fakes.js";

const OTHER_ASSET: TreasuryAsset = { ...ASSET, assetId: `${ASSET.assetId}:other` };

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    signed: 0,
    broadcast: 0,
    monitored: 0,
    confirmed: 0,
    finalized: 0,
    reorged: 0,
    blocked: 0,
    failed: 0,
    ...overrides,
  };
}

function reconciliation(assetId: string, mismatch = false): ReconciliationOutcome {
  return { assetId, mismatch, custodyAtomic: "0", expectedAtomic: "0", incident: null };
}

function spyLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies CustodyLogger;
}

interface WorkflowMocks {
  runOnce: ReturnType<typeof vi.fn>;
  reconcileAsset: ReturnType<typeof vi.fn>;
}

function makeWorkflow(
  runOnce: ReturnType<typeof vi.fn> = vi.fn(async () => summary()),
  reconcileAsset: ReturnType<typeof vi.fn> = vi.fn(async (assetId: string) =>
    reconciliation(assetId)
  )
): { workflow: WithdrawalWorkflow; mocks: WorkflowMocks } {
  const mocks = { runOnce, reconcileAsset };
  return { workflow: mocks as unknown as WithdrawalWorkflow, mocks };
}

function makeAssets(assets: TreasuryAsset[] = [ASSET]): {
  assets: AssetRegistry;
  list: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async () => assets);
  return { assets: { list } as unknown as AssetRegistry, list };
}

function makeHeartbeats(impl?: () => Promise<unknown>): {
  heartbeats: CustodyHeartbeatWriter;
  writeAll: ReturnType<typeof vi.fn>;
} {
  const writeAll = vi.fn(impl ?? (async () => []));
  return { heartbeats: { writeAll } as unknown as CustodyHeartbeatWriter, writeAll };
}

describe("CustodyWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tick delegates directly to the workflow runOnce", async () => {
    const { workflow, mocks } = makeWorkflow();
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, spyLogger(), {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    await expect(worker.tick()).resolves.toEqual(summary());
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
  });

  it("reconcileAll visits every asset and aggregates outcomes", async () => {
    const { workflow, mocks } = makeWorkflow(
      undefined,
      vi.fn(async (assetId: string) => reconciliation(assetId))
    );
    const { assets } = makeAssets([ASSET, OTHER_ASSET]);
    const worker = new CustodyWorker(workflow, assets, spyLogger(), {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    const outcomes = await worker.reconcileAll();

    expect(mocks.reconcileAsset.mock.calls.map((call) => call[0])).toEqual([
      ASSET.assetId,
      OTHER_ASSET.assetId,
    ]);
    expect(outcomes).toHaveLength(2);
  });

  it("reconcileAll isolates a failing asset and keeps reconciling the rest", async () => {
    const logger = spyLogger();
    const reconcileAsset = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce(reconciliation(OTHER_ASSET.assetId));
    const { workflow } = makeWorkflow(undefined, reconcileAsset);
    const { assets } = makeAssets([ASSET, OTHER_ASSET]);
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    const outcomes = await worker.reconcileAll();

    expect(outcomes).toEqual([reconciliation(OTHER_ASSET.assetId)]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: ASSET.assetId, error: "rpc down" }),
      "treasury reconciliation failed"
    );
  });

  it("start runs an immediate pass and schedules both intervals", async () => {
    const logger = spyLogger();
    const { workflow, mocks } = makeWorkflow(vi.fn(async () => summary({ signed: 1 })));
    const { assets, list } = makeAssets([ASSET]);
    const { heartbeats, writeAll } = makeHeartbeats();
    const worker = new CustodyWorker(
      workflow,
      assets,
      logger,
      {
        intervalMs: 1000,
        reconcileIntervalMs: 5000,
      },
      heartbeats
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalled();
    expect(writeAll).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 1000, reconcileIntervalMs: 5000 }),
      "custody worker started"
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.runOnce).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    // 5s elapsed: immediate + one pass at each of t=1..5s, and reconcile at t=0 and t=5s.
    expect(mocks.runOnce).toHaveBeenCalledTimes(6);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("start is idempotent while running and stop halts the loops", async () => {
    const logger = spyLogger();
    const { workflow, mocks } = makeWorkflow();
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      logger.info.mock.calls.filter(([, msg]) => msg === "custody worker started")
    ).toHaveLength(1);
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);

    worker.stop();
    expect(logger.info).toHaveBeenCalledWith({}, "custody worker stopped");

    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
  });

  it("stop is safe before start", () => {
    const logger = spyLogger();
    const { workflow } = makeWorkflow();
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    expect(() => worker.stop()).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith({}, "custody worker stopped");
  });

  it("logs an error and keeps running when a withdrawal pass throws", async () => {
    const logger = spyLogger();
    const { workflow, mocks } = makeWorkflow(
      vi.fn().mockRejectedValueOnce(new Error("workflow exploded")).mockResolvedValue(summary())
    );
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith(
      { error: "workflow exploded" },
      "custody withdrawal pass failed"
    );

    // The next interval still runs: the ticking guard was released in finally.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.runOnce).toHaveBeenCalledTimes(2);
  });

  it("swallows heartbeat write failures without failing the pass", async () => {
    const logger = spyLogger();
    const { workflow, mocks } = makeWorkflow();
    const { assets } = makeAssets();
    const { heartbeats } = makeHeartbeats(async () => {
      throw new Error("db unavailable");
    });
    const worker = new CustodyWorker(
      workflow,
      assets,
      logger,
      { intervalMs: 1000, reconcileIntervalMs: 5000 },
      heartbeats
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { error: "db unavailable" },
      "custody heartbeat write failed"
    );
  });

  it("does not log a withdrawal pass when every counter is zero", async () => {
    const logger = spyLogger();
    const { workflow } = makeWorkflow();
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "custody withdrawal pass");
  });

  it("logs a withdrawal pass when any activity counter is non-zero", async () => {
    const logger = spyLogger();
    const { workflow } = makeWorkflow(vi.fn(async () => summary({ failed: 2 })));
    const { assets } = makeAssets();
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ failed: 2 }),
      "custody withdrawal pass"
    );
  });

  it("surfaces a reconciliation mismatch as a logged error", async () => {
    const logger = spyLogger();
    const { workflow } = makeWorkflow(
      undefined,
      vi.fn(async (assetId: string) => reconciliation(assetId, true))
    );
    const { assets } = makeAssets([ASSET]);
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith(
      { mismatch: [reconciliation(ASSET.assetId, true)] },
      "treasury reconciliation mismatch"
    );
  });

  it("logs an error when the asset registry itself fails during reconciliation", async () => {
    const logger = spyLogger();
    const { workflow } = makeWorkflow();
    const list = vi.fn(async () => {
      throw new Error("registry offline");
    });
    const assets = { list } as unknown as AssetRegistry;
    const worker = new CustodyWorker(workflow, assets, logger, {
      intervalMs: 1000,
      reconcileIntervalMs: 5000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith(
      { error: "registry offline" },
      "treasury reconciliation pass failed"
    );
  });

  it("does not reconcile again while one reconciliation is still in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { workflow, mocks } = makeWorkflow(
      undefined,
      vi.fn(async (assetId: string) => {
        await gate;
        return reconciliation(assetId);
      })
    );
    const { assets } = makeAssets([ASSET]);
    const worker = new CustodyWorker(workflow, assets, spyLogger(), {
      intervalMs: 1000,
      reconcileIntervalMs: 1000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reconcileAsset).toHaveBeenCalledTimes(1);

    // Fire the interval while the first reconcile is still awaiting the gate.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.reconcileAsset).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.resolve();
  });
});
