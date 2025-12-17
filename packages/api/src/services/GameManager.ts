import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type Redlock from "redlock";
import type { PrismaClient } from "../../generated/prisma/index.js";
import {
  PokerEngine,
  type Action,
  type PublicState,
  type GameState,
  type Snapshot as EngineSnapshot,
} from "@pokertools/engine";
import crypto from "node:crypto";
import { NotFoundError } from "../utils/errors.js";

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
    private queue: Queue,
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
  async processAction(tableId: string, action: Action, userId: string): Promise<PublicState> {
    // 1. Acquire distributed lock (15s TTL in test, 10s in production for safety)
    const lockTTL = process.env.NODE_ENV === "test" ? 15000 : 10000;
    const lock = await this.redlock.acquire([`lock:table:${tableId}`], lockTTL);

    // Track if we need to extend lock for long operations
    const lockStartTime = Date.now();
    const lockExtendThreshold = lockTTL * 0.6; // Extend at 60% of TTL

    try {
      // 2. Load state from Redis
      const rawState = await this.redis.get(`table:${tableId}`);
      if (!rawState) {
        throw new NotFoundError("Table");
      }

      // 3. Restore Engine
      const previousSnapshot: Snapshot = JSON.parse(rawState);
      const initialVersion = previousSnapshot._version || 0;
      const engine = PokerEngine.restore(previousSnapshot);

      // 4. Identity validation (API responsibility)
      if ("playerId" in action && action.playerId !== userId && action.type !== "TIMEOUT") {
        throw new Error("Identity mismatch: Cannot act for another player");
      }

      // 5. Execute action (Engine responsibility - validates rules)
      engine.act(action);

      // Check if we need to extend lock before expensive operations
      if (Date.now() - lockStartTime > lockExtendThreshold) {
        try {
          await lock.extend(lockTTL);
        } catch (_err) {
          // Lock extension failed - another process may have taken over
          throw new Error("Lock expired during operation - operation aborted");
        }
      }

      // 6. Persist new state with optimistic concurrency check
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
          "86400"
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("Version mismatch")) {
          throw new Error("Concurrent modification detected - state changed during operation");
        }
        throw err;
      }

      // Schedule async cold storage
      await this.queue.add("persist-snapshot", {
        tableId,
        snapshot: newSnapshot,
      });

      // 7. Handle side effects
      if (engine.state.winners) {
        await this.handleHandCompletion(tableId, engine, previousSnapshot);
      } else {
        await this.scheduleTimeout(tableId, engine.state, currentVersion);
      }

      // 8. Publish lightweight event for WebSocket subscribers
      await this.redis.publish(
        `pubsub:table:${tableId}`,
        JSON.stringify({
          type: "STATE_UPDATE",
          tableId,
          version: currentVersion,
        })
      );

      // Return masked view for the actor
      return engine.view(userId, currentVersion);
    } finally {
      await lock.release();
    }
  }

  /**
   * Create a new table
   */
  async createTable(config: {
    name: string;
    mode: "CASH" | "TOURNAMENT";
    smallBlind: number;
    bigBlind: number;
    maxPlayers: number;
    minBuyIn?: number;
    maxBuyIn?: number;
  }): Promise<string> {
    // Create database record
    const table = await this.prisma.table.create({
      data: {
        name: config.name,
        mode: config.mode,
        config: config,
        status: "WAITING",
      },
    });

    // Initialize engine state in Redis
    const engineConfig: {
      smallBlind: number;
      bigBlind: number;
      maxPlayers: number;
      blindStructure?: Array<{ smallBlind: number; bigBlind: number; ante: number }>;
    } = {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      maxPlayers: config.maxPlayers,
    };

    // Add default blind structure for tournaments
    if (config.mode === "TOURNAMENT") {
      engineConfig.blindStructure = [
        { smallBlind: config.smallBlind, bigBlind: config.bigBlind, ante: 0 },
        { smallBlind: config.smallBlind * 2, bigBlind: config.bigBlind * 2, ante: 0 },
        {
          smallBlind: config.smallBlind * 3,
          bigBlind: config.bigBlind * 3,
          ante: config.smallBlind,
        },
        {
          smallBlind: config.smallBlind * 4,
          bigBlind: config.bigBlind * 4,
          ante: config.smallBlind * 2,
        },
      ];
    }

    const engine = new PokerEngine(engineConfig);

    const snapshot: Snapshot = engine.snapshot;
    snapshot._version = 0;

    await this.redis.set(`table:${table.id}`, JSON.stringify(snapshot), "EX", 86400);

    return table.id;
  }

  /**
   * Get current state with view masking
   */
  async getState(tableId: string, userId?: string): Promise<PublicState> {
    const rawState = await this.redis.get(`table:${tableId}`);
    if (!rawState) {
      throw new NotFoundError("Table");
    }

    const snapshot: Snapshot = JSON.parse(rawState);
    const engine = PokerEngine.restore(snapshot);
    const version = snapshot._version ?? 0;

    // Delegate masking to Engine
    return engine.view(userId, version);
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

    // A. Calculate net changes per player
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

    // B. Schedule settlement (Engine calculated rake already)
    await this.queue.add("settle-hand", {
      tableId,
      handId,
      playerNetChanges,
      rakeTotal: engine.state.rakeThisHand.toString(),
    });

    // C. Archive hand history
    await this.queue.add("archive-hand", {
      tableId,
      handId,
      snapshot: engine.snapshot,
    });

    // D. Auto-deal next hand if enough players
    const activePlayers = engine.state.players.filter((p) => p && p.stack > 0).length;
    if (activePlayers >= 2) {
      await this.queue.add("next-hand", { tableId }, { delay: 5000 });
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
    const baseTimeoutSeconds = state.config.timeBankSeconds ?? 30;
    let timeoutSeconds = baseTimeoutSeconds;

    // If time bank is active for this player, give them extended time
    if (state.timeBankActiveSeat === state.actionTo) {
      const timeBankDeduction = state.config.timeBankDeductionSeconds ?? 10;
      // Player gets the base time PLUS the time bank deduction they just activated
      timeoutSeconds = baseTimeoutSeconds + timeBankDeduction;
    }

    const timeoutMs = timeoutSeconds * 1000;

    await this.queue.add(
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
}
