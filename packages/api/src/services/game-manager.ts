import type { Redis } from "ioredis";
import type { JobsOptions } from "bullmq";
import type Redlock from "redlock";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { JobQueues } from "../plugins/queue.js";
import {
  PokerEngine,
  type Action,
  type PublicState,
  type GameState,
  type Snapshot as EngineSnapshot,
} from "@pokertools/engine";
import crypto from "node:crypto";
import { config as appConfig } from "../config.js";
import { NotFoundError } from "../utils/errors.js";
import { defaultBlindStructure } from "../utils/tournaments.js";

interface Snapshot extends EngineSnapshot {
  _version?: number;
}

/**
 * Game Manager - Orchestrates the poker engine with persistence
 *
 * Responsibilities:
 * - Distributed locking for serial action processing
 * - State persistence (Redis hot cache + async PostgreSQL)
 * - Side effect handling (hand settlement, history archiving)
 * - Timeout scheduling with version control
 *
 * NOTE: This is a "thin" orchestrator. ALL game logic is delegated to PokerEngine.
 */
export class GameManager {
  constructor(
    private redis: Redis,
    private redlock: Redlock,
    private queues: JobQueues,
    private prisma: PrismaClient
  ) {}

  /**
   * Process a game action with distributed locking
   *
   * Lock TTL Tuning:
   * - 10s TTL is generous for a simple action (typically < 100ms)
   * - Extension at 60% threshold prevents lock expiry during DB operations
   * - Redlock drift factor: defaults to 0.01 (1% of TTL)
   * - For multi-node Redis: ensure clocks are synchronized (NTP recommended)
   * - Monitor lock acquisition failures - may indicate network latency or contention
   */
  async processAction(
    tableId: string,
    action: Action,
    userId: string,
    options: { skipLock?: boolean; skipIdentity?: boolean } = {}
  ): Promise<PublicState> {
    const lockTTL =
      appConfig.NODE_ENV === "test"
        ? appConfig.TABLE_LOCK_TTL_MS_TEST
        : appConfig.TABLE_LOCK_TTL_MS;
    const lock = options.skipLock
      ? null
      : await this.redlock.acquire([`lock:table:${tableId}`], lockTTL);

    const lockStartTime = Date.now();
    const lockExtendThreshold = lockTTL * 0.6;

    try {
      // Load state from Redis, recovering from the DB snapshot if hot cache expired
      const previousSnapshot = await this.loadSnapshot(tableId);
      const initialVersion = previousSnapshot._version || 0;
      const engine = PokerEngine.restore(previousSnapshot);

      // Identity validation (API responsibility)
      if (
        !options.skipIdentity &&
        "playerId" in action &&
        action.playerId !== userId &&
        action.type !== "TIMEOUT"
      ) {
        throw new Error("Identity mismatch: Cannot act for another player");
      }

      // Execute action (Engine responsibility - validates rules)
      engine.act(action);

      // Check if we need to extend lock before expensive operations
      if (Date.now() - lockStartTime > lockExtendThreshold) {
        try {
          await lock?.extend(lockTTL);
        } catch (err) {
          // Lock extension failed - another process may have taken over
          throw new Error("Lock expired during operation - operation aborted", { cause: err });
        }
      }

      // Persist new state with optimistic concurrency check
      const newSnapshot: Snapshot = engine.snapshot;
      const currentVersion = initialVersion + 1;
      newSnapshot._version = currentVersion;

      // Use Lua script for atomic check-and-set with version validation
      const setScript = `
        local key = KEYS[1]
        local expectedVersion = tonumber(ARGV[1])
        local newValue = ARGV[2]
        local ttl = tonumber(ARGV[3])

        local current = redis.call('GET', key)
        if current == false then
          return redis.error_reply('Table state not found')
        end

        -- Guard against corrupted state (empty string, malformed JSON)
        if current == '' then
          return redis.error_reply('Table state is empty')
        end

        local ok, currentData = pcall(cjson.decode, current)
        if not ok then
          return redis.error_reply('Table state is corrupted (invalid JSON)')
        end

        if type(currentData) ~= 'table' then
          return redis.error_reply('Table state is not a valid object')
        end

        local currentVersion = currentData._version or 0

        if currentVersion ~= expectedVersion then
          return redis.error_reply('Version mismatch: expected ' .. expectedVersion .. ', got ' .. currentVersion)
        end

        redis.call('SET', key, newValue, 'EX', ttl)
        return 'OK'
      `;

      try {
        await this.redis.eval(
          setScript,
          1,
          `table:${tableId}`,
          initialVersion.toString(),
          JSON.stringify(newSnapshot),
          String(appConfig.TABLE_REDIS_TTL_SECONDS)
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("Version mismatch")) {
          throw new Error("Concurrent modification detected - state changed during operation", {
            cause: err,
          });
        }
        throw err;
      }

      await this.enqueue("persist-snapshot", {
        tableId,
        snapshot: newSnapshot,
      });
      await this.prisma.table.update({
        where: { id: tableId },
        data: { state: JSON.stringify(newSnapshot) },
      });

      // Handle side effects
      if (engine.state.winners) {
        await this.handleHandCompletion(tableId, engine, previousSnapshot);
      } else {
        await this.scheduleTimeout(tableId, engine.state, currentVersion);
      }

      // Publish lightweight event for WebSocket subscribers
      await this.redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: currentVersion,
          timestamp: Date.now(),
        })
      );

      // Return masked view for the actor
      return engine.view(userId, currentVersion);
    } finally {
      await lock?.release();
    }
  }

  async createTable(config: {
    name: string;
    mode: "CASH" | "TOURNAMENT";
    smallBlind: number;
    bigBlind: number;
    maxPlayers: number;
    minBuyIn?: number;
    maxBuyIn?: number;
    blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
    startingStack?: number;
    ante?: number;
    rakePercent?: number;
    rakeCap?: number;
    noFlopNoDrop?: boolean;
    timeBankSeconds?: number;
    timeBankDeductionSeconds?: number;
    actionTimeoutSeconds?: number;
    allowSpectators?: boolean;
  }): Promise<string> {
    const table = await this.prisma.table.create({
      data: {
        name: config.name,
        mode: config.mode,
        config: config,
        status: "WAITING",
      },
    });

    const engineConfig: {
      smallBlind: number;
      bigBlind: number;
      maxPlayers: number;
      ante?: number;
      rakePercent?: number;
      rakeCap?: number;
      noFlopNoDrop?: boolean;
      timeBankSeconds?: number;
      timeBankDeductionSeconds?: number;
      blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
    } = {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      maxPlayers: config.maxPlayers,
      ante: config.ante,
      rakePercent: config.rakePercent,
      rakeCap: config.rakeCap,
      noFlopNoDrop: config.noFlopNoDrop,
      timeBankSeconds: config.timeBankSeconds,
      timeBankDeductionSeconds: config.timeBankDeductionSeconds,
    };

    // Add default blind structure for tournaments
    if (config.mode === "TOURNAMENT") {
      engineConfig.blindStructure =
        config.blindStructure ?? defaultBlindStructure(config.smallBlind, config.bigBlind);
    }

    const engine = new PokerEngine(engineConfig);

    const snapshot: Snapshot = engine.snapshot;
    snapshot._version = 0;

    await Promise.all([
      this.redis.set(
        `table:${table.id}`,
        JSON.stringify(snapshot),
        "EX",
        appConfig.TABLE_REDIS_TTL_SECONDS
      ),
      this.prisma.table.update({
        where: { id: table.id },
        data: { state: JSON.stringify(snapshot) },
      }),
    ]);

    return table.id;
  }

  /**
   * Get current state with view masking
   */
  async getState(tableId: string, userId?: string): Promise<PublicState> {
    const snapshot = await this.loadSnapshot(tableId);
    const engine = PokerEngine.restore(snapshot);
    const version = snapshot._version ?? 0;

    // Delegate masking to Engine
    return engine.view(userId, version);
  }

  /**
   * Load hot Redis state with a durable DB fallback. If Redis is empty/corrupt but
   * Table.state exists, restore it to Redis and continue. This makes normal reads,
   * WebSocket joins, and action processing self-healing after Redis loss/restart.
   */
  private async loadSnapshot(tableId: string): Promise<Snapshot> {
    const key = `table:${tableId}`;
    const rawState = await this.redis.get(key);
    if (rawState) {
      try {
        return JSON.parse(rawState) as Snapshot;
      } catch (error) {
        await this.redis.del(key);
        console.warn(`Table state in Redis is corrupted for ${tableId}; recovering from DB`, error);
      }
    }

    const table = await this.prisma.table.findUnique({
      where: { id: tableId },
      select: { state: true },
    });

    if (!table) throw new NotFoundError("Table");
    if (!table.state) throw new NotFoundError("Table state");

    const snapshot =
      typeof table.state === "string"
        ? (JSON.parse(table.state) as Snapshot)
        : (table.state as unknown as Snapshot);
    snapshot._version = snapshot._version ?? 0;
    await this.redis.set(key, JSON.stringify(snapshot), "EX", appConfig.TABLE_REDIS_TTL_SECONDS);
    return snapshot;
  }

  /**
   * Handle hand completion (financial settlement + history)
   */
  private async handleHandCompletion(
    tableId: string,
    engine: PokerEngine,
    previousSnapshot: Snapshot
  ): Promise<void> {
    const handId = crypto.randomUUID();

    const playerNetChanges: Record<string, string> = {};

    for (const player of engine.state.players) {
      if (!player) continue;

      const previousPlayer = previousSnapshot.players.find((p) => p?.id === player.id);
      const stackBefore = previousPlayer ? previousPlayer.stack : 0;
      const stackAfter = player.stack;
      const netChange = stackAfter - stackBefore;

      if (netChange !== 0) {
        playerNetChanges[player.id] = netChange.toString();
      }
    }

    // Schedule settlement (Engine calculated rake already)
    await this.enqueue(
      "settle-hand",
      {
        tableId,
        handId,
        playerNetChanges,
        rakeTotal: engine.state.rakeThisHand.toString(),
      },
      { jobId: `settle_${handId}`, attempts: 10, backoff: { type: "exponential", delay: 500 } }
    );

    // Archive hand history
    await this.enqueue("archive-hand", {
      tableId,
      handId,
      snapshot: engine.snapshot,
    });

    // Auto-deal next hand if enough players
    const activePlayers = engine.state.players.filter((p) => p && p.stack > 0).length;
    if (activePlayers >= 2) {
      await this.enqueue("next-hand", { tableId }, { delay: appConfig.AUTO_DEAL_DELAY_MS });
    }
  }

  /**
   * Schedule timeout with version control (prevents race conditions)
   */
  private async scheduleTimeout(tableId: string, state: GameState, version: number): Promise<void> {
    if (state.actionTo === null) return;

    const player = state.players[state.actionTo];
    if (!player) return;

    // Calculate timeout duration based on whether time bank is active
    const storedConfig = state.config as typeof state.config & { actionTimeoutSeconds?: number };
    const baseTimeoutSeconds =
      storedConfig.actionTimeoutSeconds ?? appConfig.ACTION_TIMEOUT_SECONDS;
    let timeoutSeconds = baseTimeoutSeconds;

    // If time bank is active for this player, give them extended time
    if (state.timeBankActiveSeat === state.actionTo) {
      const timeBankDeduction = state.config.timeBankDeductionSeconds ?? 10;
      // Player gets the base time PLUS the time bank deduction they just activated
      timeoutSeconds = baseTimeoutSeconds + timeBankDeduction;
    }

    const timeoutMs = timeoutSeconds * 1000;

    await this.enqueue(
      "player-timeout",
      {
        tableId,
        playerId: player.id,
        expectedVersion: version, // Critical for race prevention
      },
      {
        delay: timeoutMs,
        jobId: `timeout_${tableId}_${state.actionTo}_${version}`,
      }
    );
  }

  private async enqueue(
    queueName: keyof JobQueues,
    data: Record<string, unknown>,
    options?: JobsOptions
  ): Promise<void> {
    await this.queues[queueName].add(queueName, data, options);
  }
}
