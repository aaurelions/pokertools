/**
 * Canonical custody worker.
 *
 * Telegram-independent: it drives the withdrawal workflow on a timer and, on a
 * slower cadence, runs treasury reconciliation. It is the only loop started by
 * the custody entrypoint.
 */
import type { AssetRegistry, CustodyLogger } from "../core/types.js";
import type { RunSummary, WithdrawalWorkflow } from "../core/withdrawal-workflow.js";
import type { ReconciliationOutcome } from "../core/withdrawal-workflow.js";
import type { CustodyHeartbeatWriter } from "./heartbeat-writer.js";

export interface CustodyWorkerConfig {
  intervalMs: number;
  reconcileIntervalMs: number;
}

export class CustodyWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private reconciling = false;

  constructor(
    private readonly workflow: WithdrawalWorkflow,
    private readonly assets: AssetRegistry,
    private readonly logger: CustodyLogger,
    private readonly config: CustodyWorkerConfig,
    private readonly heartbeats?: CustodyHeartbeatWriter
  ) {}

  /** One withdrawal pass. Exposed for tests and manual invocation. */
  async tick(): Promise<RunSummary> {
    return this.workflow.runOnce();
  }

  async reconcileAll(): Promise<ReconciliationOutcome[]> {
    const assets = await this.assets.list();
    const outcomes: ReconciliationOutcome[] = [];
    for (const asset of assets) {
      try {
        outcomes.push(await this.workflow.reconcileAsset(asset.assetId));
      } catch (error) {
        this.logger.error(
          { assetId: asset.assetId, error: error instanceof Error ? error.message : String(error) },
          "treasury reconciliation failed"
        );
      }
    }
    return outcomes;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      { intervalMs: this.config.intervalMs, reconcileIntervalMs: this.config.reconcileIntervalMs },
      "custody worker started"
    );

    void this.runTick();
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.config.intervalMs);

    void this.runReconcile();
    this.reconcileTimer = setInterval(() => {
      void this.runReconcile();
    }, this.config.reconcileIntervalMs);
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const summary = await this.tick();
      const active =
        summary.signed +
        summary.broadcast +
        summary.confirmed +
        summary.finalized +
        summary.reorged +
        summary.blocked +
        summary.failed;
      if (active > 0) {
        this.logger.info(summary, "custody withdrawal pass");
      }
      await this.writeHeartbeats();
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "custody withdrawal pass failed"
      );
    } finally {
      this.ticking = false;
    }
  }

  private async writeHeartbeats(): Promise<void> {
    if (!this.heartbeats) return;
    try {
      await this.heartbeats.writeAll();
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "custody heartbeat write failed"
      );
    }
  }

  private async runReconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const outcomes = await this.reconcileAll();
      const mismatch = outcomes.filter((outcome) => outcome.mismatch);
      if (mismatch.length > 0) {
        this.logger.error({ mismatch }, "treasury reconciliation mismatch");
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "treasury reconciliation pass failed"
      );
    } finally {
      this.reconciling = false;
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.logger.info({}, "custody worker stopped");
  }
}
