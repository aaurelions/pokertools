import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "../../generated/prisma/index.js";
import {
  FinancialReadinessSchema,
  type FinancialReadiness,
  type ReadinessReason,
  type ReadinessState,
} from "@pokertools/types";

/**
 * Live platform readiness.
 *
 * `/health` is liveness. This service answers a different, fail-closed
 * question: is it safe to admit real financial traffic? It never turns a
 * reachable dependency into a passing grade on its own.
 *
 * Design rules enforced here:
 *
 * - **Fail closed.** A missing row, missing provenance, missing probe or an
 *   unreadable/timed-out probe is a failure, never a skip.
 * - **Bounded.** Every probe runs under a wall-clock timeout; a hung RPC or
 *   database call cannot stall the endpoint.
 * - **No leakage.** Details are stable machine codes. Raw errors, RPC
 *   credential URLs, connection strings and signer material are never copied
 *   into a result or surfaced to the caller.
 * - **Real persistence checks.** Migration integrity, ledger invariants,
 *   durable table/outbox cursors, assets, incidents, reconciliation and
 *   provenance are queried from the real database. Only network/external
 *   operations (RPC quorum, custody/signer) are
 *   injected behind small interfaces and wired by `readiness-adapters.ts`
 *   (see `services/chain-registry.ts`, `services/atomic-ledger.ts` and the
 *   custody package).
 * The returned report carries a canonical `FinancialReadiness` sub-payload
 * (`@pokertools/types`). The HTTP adapter maps the outer envelope to
 * the transport schema; the internal check list is deliberately richer than
 * the canonical reason enum.
 */

// ============================================================================
// Public constants
// ============================================================================

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_OUTBOX_MAX_PENDING_AGE_MS = 5 * 60_000;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 10;
export const DEFAULT_RECONCILIATION_MAX_AGE_MS = 30 * 60_000;

/** Upper bound on assets verified per pass (fail closed above it). */
export const MAX_ASSETS_VERIFIED = 200;

export type DatabaseProvider = "postgres" | "sqlite";

// ============================================================================
// Probe contracts (dependency-inverted external operations)
// ============================================================================

export interface ProbeOutcome {
  state: ReadinessState;
  /** Stable machine code. Never raw error text, URLs or secrets. */
  code: string;
}

export interface MigrationIntegrityProbe {
  check(): Promise<{ ok: boolean; code: string; expected?: number; applied?: number }>;
}

export interface RedisHealthProbe {
  check(): Promise<{ ok: boolean; code: string }>;
}

export interface QueueHealthProbe {
  check(): Promise<{ ok: boolean; code: string; failed?: number; waiting?: number }>;
}

/** RPC endpoint quorum probe. Backed by `services/chain-registry.ts`. */
export interface ChainQuorumProbe {
  verifyQuorum(): Promise<{ ok: boolean; code: string; chainsChecked?: number }>;
}

/**
 * Immutable balanced journal + rebuildable projection probe. Backed by
 * `services/atomic-ledger.ts`. When omitted the service runs the equivalent
 * invariants directly against Prisma.
 */
export interface LedgerIntegrityProbe {
  verify(): Promise<{ ok: boolean; code: string }>;
}

/**
 * Custody signer/gas readiness. Must be evaluated outside the API process:
 * the API never loads or reads signer secrets.
 */
export interface CustodyReadinessProbe {
  checkReadiness(): Promise<{ ready: boolean; gasReady: boolean; code: string; gasCode?: string }>;
}

/** Operational freeze state. Freeze blocks new risk, not monitoring. */
export interface FreezeStateProvider {
  getState(): Promise<{ frozen: boolean; code: string }>;
}

// ============================================================================
// Option / report types
// ============================================================================

export interface PlatformReadinessOptions {
  prisma: PrismaClient;
  /** Real ioredis/bullmq adapters are provided by the integrator. */
  redis?: RedisHealthProbe;
  queue?: QueueHealthProbe;
  /** Defaults to the real filesystem + Prisma PostgreSQL manifest probe. */
  migrations?: MigrationIntegrityProbe;
  /** Optional override for the Prisma ledger invariants below. */
  ledger?: LedgerIntegrityProbe;
  chainQuorum?: ChainQuorumProbe;
  custody?: CustodyReadinessProbe;
  freeze?: FreezeStateProvider;
  now?: () => number;
  /** Monotonic milliseconds for cache expiry and latency, independent of wall time. */
  elapsedNow?: () => number;
  /** Defaults to `process.env.NODE_ENV`. */
  nodeEnv?: string;
  /** Defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /**
   * True when on-chain payouts/custody are operationally enabled. A function
   * is resolved per evaluation, because configured canonical assets can appear
   * after process start.
   */
  payoutsEnabled?: boolean | (() => Promise<boolean>);
  probeTimeoutMs?: number;
  /**
   * Optional whole-report cache TTL in milliseconds. `0` (default) disables
   * caching. The production adapter enables a short TTL so `/ready` does not
   * trigger an RPC scan on every probe.
   */
  cacheTtlMs?: number;
  outboxMaxPendingAgeMs?: number;
  outboxMaxAttempts?: number;
  reconciliationMaxAgeMs?: number;
  /** Force reconciliation gating even without active assets. */
  reconciliationRequired?: boolean;
  /** Force RPC quorum gating even without active assets. */
  rpcQuorumRequired?: boolean;
}

export interface PlatformReadinessCheck {
  name: string;
  state: ReadinessState;
  /** Informational: every reported check must be READY for readiness. */
  mandatory: boolean;
  latencyMs: number;
  /** Stable machine code only. */
  detail: string;
}

export interface PlatformReadinessReport {
  state: ReadinessState;
  ready: boolean;
  timestamp: number;
  checks: PlatformReadinessCheck[];
  /** Canonical financial sub-payload validated against @pokertools/types. */
  financial: FinancialReadiness;
}

// ============================================================================
// Migration manifest probe
// ============================================================================

const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL("../../prisma/postgres/migrations.json", import.meta.url)
);

const MANIFEST_NAME_PATTERN = /^\d{3}_[a-z0-9_]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface ManifestEntry {
  name: string;
  sha256: string;
}

class ManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManifestError";
  }
}

export function providerFromUrl(url: string | undefined): DatabaseProvider {
  return url !== undefined && /^postgres(ql)?:\/\//.test(url) ? "postgres" : "sqlite";
}

function loadManifest(manifestPath: string): { entries: ManifestEntry[]; unlisted: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new ManifestError("MIGRATION_MANIFEST_UNREADABLE");
  }
  const migrations = (raw as { migrations?: unknown }).migrations;
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new ManifestError("MIGRATION_MANIFEST_INVALID");
  }

  const directory = dirname(manifestPath);
  const names = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const item of migrations) {
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.name !== "string" ||
      !MANIFEST_NAME_PATTERN.test(entry.name) ||
      entry.file !== `${entry.name}.sql` ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256) ||
      names.has(entry.name)
    ) {
      throw new ManifestError("MIGRATION_MANIFEST_INVALID");
    }
    names.add(entry.name);
    let sql: string;
    try {
      sql = readFileSync(resolve(directory, `${entry.name}.sql`), "utf8");
    } catch {
      throw new ManifestError("MIGRATION_FILE_MISSING");
    }
    if (createHash("sha256").update(sql).digest("hex") !== entry.sha256) {
      throw new ManifestError("MIGRATION_FILE_DRIFT");
    }
    entries.push({ name: entry.name, sha256: entry.sha256 });
  }

  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    throw new ManifestError("MIGRATION_DIRECTORY_UNREADABLE");
  }
  const unlisted = files.filter((file) => file.endsWith(".sql") && !names.has(file.slice(0, -4)));
  return { entries, unlisted };
}

export interface ManifestMigrationProbeOptions {
  manifestPath?: string;
  databaseUrl?: string;
  nodeEnv?: string;
  /** Overrides provider inference (used to exercise PostgreSQL logic). */
  provider?: DatabaseProvider;
  /** Require every `*.sql` file beside the manifest to be listed. Default true. */
  requireCompleteManifest?: boolean;
}

/**
 * Real filesystem + `_migrations` migration integrity probe.
 *
 * - Every manifest entry must hash-match its SQL file (drift fails).
 * - Every `*.sql` file must be listed (an unlisted migration is incomplete).
 * - On PostgreSQL every manifest entry must be applied in `_migrations` with
 *   an identical hash; unknown rows fail too.
 * - SQLite is a non-production convenience and is rejected under NODE_ENV
 *   production (the database check blocks it earlier as well).
 */
export class ManifestMigrationIntegrityProbe implements MigrationIntegrityProbe {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ManifestMigrationProbeOptions = {}
  ) {}

  async check(): Promise<{ ok: boolean; code: string; expected?: number; applied?: number }> {
    const manifestPath = this.options.manifestPath ?? DEFAULT_MANIFEST_PATH;
    let manifest: { entries: ManifestEntry[]; unlisted: string[] };
    try {
      manifest = loadManifest(manifestPath);
    } catch (error) {
      return {
        ok: false,
        code: error instanceof ManifestError ? error.code : "MIGRATION_MANIFEST_INVALID",
      };
    }

    if ((this.options.requireCompleteManifest ?? true) && manifest.unlisted.length > 0) {
      return { ok: false, code: "MIGRATION_MANIFEST_INCOMPLETE" };
    }

    const nodeEnv = this.options.nodeEnv ?? process.env.NODE_ENV;
    const provider =
      this.options.provider ??
      providerFromUrl(this.options.databaseUrl ?? process.env.DATABASE_URL);

    if (provider !== "postgres") {
      if (nodeEnv === "production") {
        return { ok: false, code: "MIGRATION_POSTGRES_REQUIRED" };
      }
      return {
        ok: true,
        code: "MIGRATION_SQLITE_DEV",
        expected: manifest.entries.length,
        applied: 0,
      };
    }

    let rows: Array<{ name: unknown; sha256: unknown }>;
    try {
      rows = await this.prisma.$queryRawUnsafe<Array<{ name: unknown; sha256: unknown }>>(
        'SELECT "name", "sha256" FROM "_migrations"'
      );
    } catch {
      return { ok: false, code: "MIGRATION_LEDGER_UNREADABLE" };
    }

    const applied = new Map<string, string>(
      rows.map((row) => [String(row.name), String(row.sha256)])
    );
    for (const name of applied.keys()) {
      if (!manifest.entries.some((entry) => entry.name === name)) {
        return {
          ok: false,
          code: "MIGRATION_UNKNOWN",
          expected: manifest.entries.length,
          applied: applied.size,
        };
      }
    }
    for (const entry of manifest.entries) {
      const appliedHash = applied.get(entry.name);
      if (appliedHash === undefined) {
        return {
          ok: false,
          code: "MIGRATION_MISSING",
          expected: manifest.entries.length,
          applied: applied.size,
        };
      }
      if (appliedHash !== entry.sha256) {
        return {
          ok: false,
          code: "MIGRATION_APPLIED_DRIFT",
          expected: manifest.entries.length,
          applied: applied.size,
        };
      }
    }

    return {
      ok: true,
      code: "MIGRATION_VERIFIED",
      expected: manifest.entries.length,
      applied: applied.size,
    };
  }
}

// ============================================================================
// Timeout / state helpers
// ============================================================================

class ProbeTimeoutError extends Error {
  constructor() {
    super("probe timeout");
    this.name = "ProbeTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const STATE_SEVERITY: Record<ReadinessState, number> = {
  READY: 0,
  DEGRADED: 1,
  NOT_READY: 2,
  BLOCKED: 3,
};

function worstState(states: ReadinessState[]): ReadinessState {
  let worst: ReadinessState = "READY";
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst;
}

/** Check name -> canonical financial reason used when the check is not READY. */
const FINANCIAL_CHECK_REASON: Record<string, ReadinessReason> = {
  ledger: "ASSET_LEDGER_UNVERIFIED",
  assets: "ASSET_LEDGER_UNVERIFIED",
  provenance: "ASSET_LEDGER_UNVERIFIED",
  incidents: "OPEN_CRITICAL_INCIDENT",
  rpcQuorum: "RPC_QUORUM_UNVERIFIED",
  reconciliation: "RECONCILIATION_UNVERIFIED",
  nativeGas: "NATIVE_GAS_UNVERIFIED",
  custody: "CUSTODY_WORKFLOW_UNVERIFIED",
};

const FINANCIAL_CHECK_NAMES = Object.keys(FINANCIAL_CHECK_REASON);

const CHECK_ORDER = [
  "database",
  "migrations",
  "redis",
  "queue",
  "gameAuthority",
  "provenance",
  "ledger",
  "assets",
  "incidents",
  "rpcQuorum",
  "reconciliation",
  "custody",
  "nativeGas",
  "freeze",
];

// ============================================================================
// Prisma ledger invariant SQL (provider-portable)
// ============================================================================

const UNBALANCED_JOURNAL_SQL =
  'SELECT "t"."id" AS "id" FROM "JournalTransaction" "t" ' +
  'JOIN "JournalPosting" "p" ON "p"."transactionId" = "t"."id" ' +
  'GROUP BY "t"."id" HAVING SUM(CAST("p"."amountAtomic" AS DECIMAL)) <> 0 LIMIT 1';

const PROJECTION_DRIFT_SQL =
  'SELECT "a"."id" AS "id" FROM "AtomicAccount" "a" ' +
  'LEFT JOIN "JournalPosting" "p" ON "p"."accountId" = "a"."id" ' +
  'GROUP BY "a"."id", "a"."balanceAtomic" ' +
  'HAVING CAST("a"."balanceAtomic" AS DECIMAL) <> COALESCE(SUM(CAST("p"."amountAtomic" AS DECIMAL)), 0) LIMIT 1';

const NEGATIVE_LIABILITY_SQL =
  'SELECT "a"."id" AS "id" FROM "AtomicAccount" "a" ' +
  "WHERE \"a\".\"class\" IN ('USER_AVAILABLE','IN_PLAY_RESERVE','PENDING_WITHDRAWAL') " +
  'AND CAST("a"."balanceAtomic" AS DECIMAL) < 0 LIMIT 1';

// ============================================================================
// Service
// ============================================================================

export class PlatformReadinessService {
  private readonly prisma: PrismaClient;
  private readonly redis?: RedisHealthProbe;
  private readonly queue?: QueueHealthProbe;
  private readonly migrations: MigrationIntegrityProbe;
  private readonly ledger?: LedgerIntegrityProbe;
  private readonly chainQuorum?: ChainQuorumProbe;
  private readonly custody?: CustodyReadinessProbe;
  private readonly freeze?: FreezeStateProvider;
  private readonly now: () => number;
  private readonly elapsedNow: () => number;
  private readonly nodeEnv: string;
  private readonly databaseUrl?: string;
  private readonly payoutsEnabled: boolean | (() => Promise<boolean>);
  private readonly cacheTtlMs: number;
  private readonly probeTimeoutMs: number;
  private readonly outboxMaxPendingAgeMs: number;
  private readonly outboxMaxAttempts: number;
  private readonly reconciliationMaxAgeMs: number;
  private readonly reconciliationRequired?: boolean;
  private readonly rpcQuorumRequired?: boolean;

  private custodyResult?: Promise<{
    ready: boolean;
    gasReady: boolean;
    code: string;
    gasCode?: string;
  }>;
  private cachedReport?: PlatformReadinessReport;
  private cachedAt = 0;
  private inflightEvaluation?: Promise<PlatformReadinessReport>;

  constructor(options: PlatformReadinessOptions) {
    this.prisma = options.prisma;
    this.redis = options.redis;
    this.queue = options.queue;
    this.migrations =
      options.migrations ??
      new ManifestMigrationIntegrityProbe(options.prisma, {
        databaseUrl: options.databaseUrl,
        nodeEnv: options.nodeEnv,
      });
    this.ledger = options.ledger;
    this.chainQuorum = options.chainQuorum;
    this.custody = options.custody;
    this.freeze = options.freeze;
    this.now = options.now ?? (() => Date.now());
    this.elapsedNow = options.elapsedNow ?? (() => performance.now());
    this.nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";
    this.databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    this.payoutsEnabled = options.payoutsEnabled ?? false;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.outboxMaxPendingAgeMs = options.outboxMaxPendingAgeMs ?? DEFAULT_OUTBOX_MAX_PENDING_AGE_MS;
    this.outboxMaxAttempts = options.outboxMaxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
    this.reconciliationMaxAgeMs =
      options.reconciliationMaxAgeMs ?? DEFAULT_RECONCILIATION_MAX_AGE_MS;
    this.reconciliationRequired = options.reconciliationRequired;
    this.rpcQuorumRequired = options.rpcQuorumRequired;
  }

  async evaluate(): Promise<PlatformReadinessReport> {
    if (this.cacheTtlMs <= 0) return this.runEvaluation();

    const now = this.elapsedNow();
    if (this.cachedReport !== undefined && now - this.cachedAt < this.cacheTtlMs) {
      return this.cachedReport;
    }
    if (this.inflightEvaluation !== undefined) return this.inflightEvaluation;

    const run = this.runEvaluation().then(
      (report) => {
        this.cachedReport = report;
        this.cachedAt = this.elapsedNow();
        this.inflightEvaluation = undefined;
        return report;
      },
      (error: unknown) => {
        this.inflightEvaluation = undefined;
        throw error;
      }
    );
    this.inflightEvaluation = run;
    return run;
  }

  private async resolvePayoutsEnabled(): Promise<boolean> {
    if (typeof this.payoutsEnabled === "function") {
      try {
        return await this.payoutsEnabled();
      } catch {
        // Unknown configuration is treated as financial: fail closed.
        return true;
      }
    }
    return this.payoutsEnabled;
  }

  private async runEvaluation(): Promise<PlatformReadinessReport> {
    const payoutsEnabled = await this.resolvePayoutsEnabled();
    // Custody evidence is re-read for every evaluation; a cached whole-report
    // (short TTL) is the only layer that may hold it.
    this.custodyResult = undefined;

    const results = await Promise.all([
      this.runCheck("database", true, () => this.checkDatabase()),
      this.runCheck("migrations", true, () => this.checkMigrations()),
      this.runCheck("redis", true, () => this.checkRedis()),
      this.runCheck("queue", true, () => this.checkQueue()),
      this.runCheck("gameAuthority", true, () => this.checkGameAuthority()),
      this.runCheck("provenance", true, () => this.checkProvenance()),
      this.runCheck("ledger", true, () => this.checkLedger()),
      this.runCheck("assets", true, () => this.checkAssets(payoutsEnabled)),
      this.runCheck("incidents", true, () => this.checkIncidents()),
      this.runCheck("rpcQuorum", true, () => this.checkRpcQuorum(payoutsEnabled)),
      this.runCheck("reconciliation", true, () => this.checkReconciliation(payoutsEnabled)),
      this.runCheck("custody", payoutsEnabled, () => this.checkCustody(payoutsEnabled)),
      this.runCheck("nativeGas", payoutsEnabled, () => this.checkNativeGas(payoutsEnabled)),
      this.runCheck("freeze", true, () => this.checkFreeze()),
    ]);

    const checks = results.sort(
      (a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name)
    );

    const state = worstState(checks.map((check) => check.state));
    const ready = checks.every((check) => check.state === "READY");

    return {
      state,
      ready,
      timestamp: this.now(),
      checks,
      financial: this.buildFinancialReadiness(checks),
    };
  }

  // --------------------------------------------------------------------------
  // Check runner
  // --------------------------------------------------------------------------

  private async runCheck(
    name: string,
    mandatory: boolean,
    probe: () => Promise<ProbeOutcome>
  ): Promise<PlatformReadinessCheck> {
    const started = this.elapsedNow();
    let outcome: ProbeOutcome;
    try {
      outcome = await withTimeout(probe(), this.probeTimeoutMs);
    } catch (error) {
      outcome = {
        state: "BLOCKED",
        code: error instanceof ProbeTimeoutError ? "PROBE_TIMEOUT" : "PROBE_FAILURE",
      };
    }
    const latencyMs = Math.max(0, Math.round(this.elapsedNow() - started));
    return { name, state: outcome.state, mandatory, latencyMs, detail: outcome.code };
  }

  // --------------------------------------------------------------------------
  // Individual checks
  // --------------------------------------------------------------------------

  private async checkDatabase(): Promise<ProbeOutcome> {
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      return { state: "BLOCKED", code: "DATABASE_UNREACHABLE" };
    }
    const provider = providerFromUrl(this.databaseUrl);
    if (this.nodeEnv === "production" && provider !== "postgres") {
      return { state: "BLOCKED", code: "POSTGRES_REQUIRED" };
    }
    return { state: "READY", code: provider === "postgres" ? "POSTGRES_OK" : "SQLITE_DEV_OK" };
  }

  private async checkMigrations(): Promise<ProbeOutcome> {
    const result = await this.migrations.check();
    return result.ok
      ? { state: "READY", code: result.code }
      : { state: "BLOCKED", code: result.code };
  }

  private async checkRedis(): Promise<ProbeOutcome> {
    if (!this.redis) return { state: "BLOCKED", code: "PROBE_UNCONFIGURED" };
    const result = await this.redis.check();
    return result.ok
      ? { state: "READY", code: "REDIS_OK" }
      : { state: "BLOCKED", code: result.code };
  }

  private async checkQueue(): Promise<ProbeOutcome> {
    if (!this.queue) return { state: "BLOCKED", code: "PROBE_UNCONFIGURED" };
    const result = await this.queue.check();
    return result.ok
      ? { state: "READY", code: "QUEUE_OK" }
      : { state: "BLOCKED", code: result.code };
  }

  private async checkGameAuthority(): Promise<ProbeOutcome> {
    const now = this.now();
    const staleCutoff = new Date(now - this.outboxMaxPendingAgeMs);

    const [stalePending, failedOutbox, exhausted] = await Promise.all([
      this.prisma.gameOutbox.count({
        where: {
          OR: [{ status: "PENDING" }, { status: "DISPATCHED", kind: { not: "pubsub" } }],
          availableAt: { lt: staleCutoff },
        },
      }),
      this.prisma.gameOutbox.count({ where: { status: "FAILED" } }),
      this.prisma.gameOutbox.count({
        where: { status: "PENDING", attempts: { gte: this.outboxMaxAttempts } },
      }),
    ]);

    // The durable Table cursors are authority; public GameEvent sequence must
    // not run ahead of the committed table eventSeq.
    const grouped = await this.prisma.gameEvent.groupBy({
      by: ["tableId"],
      _max: { eventSeq: true },
    });
    if (grouped.length > 0) {
      const maxByTable = new Map(grouped.map((group) => [group.tableId, group._max.eventSeq ?? 0]));
      const tables = await this.prisma.table.findMany({
        where: { id: { in: [...maxByTable.keys()] } },
        select: { id: true, eventSeq: true },
      });
      for (const table of tables) {
        if ((maxByTable.get(table.id) ?? 0) !== table.eventSeq) {
          return { state: "BLOCKED", code: "GAME_EVENT_SEQUENCE_DRIFT" };
        }
      }
    }

    if (stalePending > 0) return { state: "NOT_READY", code: "OUTBOX_STALE_PENDING" };
    if (failedOutbox > 0) return { state: "NOT_READY", code: "OUTBOX_FAILED" };
    if (exhausted > 0) return { state: "NOT_READY", code: "OUTBOX_ATTEMPTS_EXHAUSTED" };
    return { state: "READY", code: "GAME_AUTHORITY_OK" };
  }

  private async checkProvenance(): Promise<ProbeOutcome> {
    const depositsMissingBlock = await this.prisma.depositClaimRecord.count({
      where: {
        status: { in: ["CONFIRMED", "CREDITED"] },
        OR: [{ blockNumber: null }, { blockHash: null }],
      },
    });
    if (depositsMissingBlock > 0) {
      return { state: "BLOCKED", code: "DEPOSIT_PROVENANCE_MISSING" };
    }

    const creditedWithoutJournal = await this.prisma.depositClaimRecord.count({
      where: { status: "CREDITED", creditedJournalId: null },
    });
    if (creditedWithoutJournal > 0) {
      return { state: "BLOCKED", code: "DEPOSIT_JOURNAL_MISSING" };
    }

    const withdrawalsMissingBytes = await this.prisma.withdrawalIntentRecord.count({
      where: {
        state: { in: ["BROADCAST", "PENDING_CONFIRMATION", "CONFIRMED", "FINALIZED"] },
        OR: [{ txHash: null }, { payloadHash: null }, { signedRawTx: null }],
      },
    });
    if (withdrawalsMissingBytes > 0) {
      return { state: "BLOCKED", code: "WITHDRAWAL_PROVENANCE_MISSING" };
    }

    const reservedWithoutJournal = await this.prisma.withdrawalIntentRecord.count({
      where: { state: "RESERVED", reservedJournalId: null },
    });
    if (reservedWithoutJournal > 0) {
      return { state: "BLOCKED", code: "WITHDRAWAL_RESERVATION_MISSING" };
    }

    return { state: "READY", code: "PROVENANCE_OK" };
  }

  private async checkLedger(): Promise<ProbeOutcome> {
    if (this.ledger) {
      const result = await this.ledger.verify();
      return result.ok
        ? { state: "READY", code: result.code }
        : { state: "BLOCKED", code: result.code };
    }

    const unbalanced =
      await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(UNBALANCED_JOURNAL_SQL);
    if (unbalanced.length > 0) return { state: "BLOCKED", code: "LEDGER_UNBALANCED" };

    const drift = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(PROJECTION_DRIFT_SQL);
    if (drift.length > 0) return { state: "BLOCKED", code: "LEDGER_PROJECTION_DRIFT" };

    const negative =
      await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(NEGATIVE_LIABILITY_SQL);
    if (negative.length > 0) return { state: "NOT_READY", code: "LEDGER_NEGATIVE_LIABILITY" };

    return { state: "READY", code: "LEDGER_OK" };
  }

  private async checkAssets(payoutsEnabled: boolean): Promise<ProbeOutcome> {
    const assets = await this.prisma.asset.findMany({
      take: MAX_ASSETS_VERIFIED + 1,
      select: {
        id: true,
        status: true,
        treasuryAddress: true,
        rpcUrls: true,
        confirmations: true,
        deepFinality: true,
      },
    });

    if (assets.length > MAX_ASSETS_VERIFIED) {
      return { state: "BLOCKED", code: "ASSET_VERIFICATION_LIMIT_EXCEEDED" };
    }

    const requireActive = payoutsEnabled || (this.reconciliationRequired ?? false);
    if (assets.length === 0) {
      return requireActive
        ? { state: "BLOCKED", code: "ASSET_NONE_CONFIGURED" }
        : { state: "READY", code: "ASSET_NONE_REQUIRED" };
    }

    for (const asset of assets) {
      const rpcUrls = asset.rpcUrls;
      const hasRpcUrls = Array.isArray(rpcUrls) ? rpcUrls.length > 0 : rpcUrls !== null;
      if (
        !/^0x[0-9a-fA-F]{40}$/.test(asset.treasuryAddress) ||
        !hasRpcUrls ||
        asset.confirmations > asset.deepFinality
      ) {
        return { state: "BLOCKED", code: "ASSET_PROVENANCE_MISSING" };
      }
    }

    if (!assets.some((asset) => asset.status === "ACTIVE")) {
      return requireActive
        ? { state: "BLOCKED", code: "ASSET_NONE_ACTIVE" }
        : { state: "NOT_READY", code: "ASSET_NONE_ACTIVE" };
    }
    if (assets.some((asset) => asset.status !== "ACTIVE")) {
      return { state: "NOT_READY", code: "ASSET_NOT_ACTIVE" };
    }

    return { state: "READY", code: "ASSET_ACTIVE" };
  }

  private async checkIncidents(): Promise<ProbeOutcome> {
    const critical = await this.prisma.financialIncident.count({
      where: { status: { not: "RESOLVED" }, severity: "CRITICAL" },
    });
    if (critical > 0) return { state: "BLOCKED", code: "OPEN_CRITICAL_INCIDENT" };

    const open = await this.prisma.financialIncident.count({
      where: { status: { not: "RESOLVED" } },
    });
    if (open > 0) return { state: "NOT_READY", code: "OPEN_INCIDENT" };

    const resolutionMissingEvidence = await this.prisma.financialIncident.count({
      where: { status: "RESOLVED", resolvedAt: null },
    });
    if (resolutionMissingEvidence > 0) {
      return { state: "NOT_READY", code: "INCIDENT_RESOLUTION_PROVENANCE_MISSING" };
    }

    return { state: "READY", code: "INCIDENTS_NONE" };
  }

  private async checkRpcQuorum(payoutsEnabled: boolean): Promise<ProbeOutcome> {
    const required =
      this.rpcQuorumRequired ??
      (payoutsEnabled || (await this.prisma.asset.count({ where: { status: "ACTIVE" } })) > 0);
    if (!required) return { state: "READY", code: "RPC_QUORUM_NOT_REQUIRED" };
    if (!this.chainQuorum) return { state: "BLOCKED", code: "PROBE_UNCONFIGURED" };

    const result = await this.chainQuorum.verifyQuorum();
    return result.ok
      ? { state: "READY", code: "RPC_QUORUM_OK" }
      : { state: "BLOCKED", code: result.code };
  }

  private async checkReconciliation(payoutsEnabled: boolean): Promise<ProbeOutcome> {
    const assets = await this.prisma.asset.findMany({
      where: { status: "ACTIVE" },
      take: MAX_ASSETS_VERIFIED + 1,
      select: { id: true },
    });
    if (assets.length > MAX_ASSETS_VERIFIED) {
      return { state: "BLOCKED", code: "ASSET_VERIFICATION_LIMIT_EXCEEDED" };
    }

    const required = this.reconciliationRequired ?? (payoutsEnabled || assets.length > 0);
    if (!required) return { state: "READY", code: "RECONCILIATION_NOT_REQUIRED" };
    if (assets.length === 0) return { state: "BLOCKED", code: "RECONCILIATION_ASSET_MISSING" };

    const now = this.now();
    for (const asset of assets) {
      const reconciliation = await this.prisma.treasuryReconciliation.findFirst({
        where: { assetId: asset.id },
        orderBy: { createdAt: "desc" },
      });
      if (!reconciliation) return { state: "BLOCKED", code: "RECONCILIATION_MISSING" };
      if (reconciliation.status !== "MATCHED" || reconciliation.differenceAtomic !== "0") {
        return { state: "BLOCKED", code: "RECONCILIATION_MISMATCH" };
      }
      if (
        reconciliation.blockNumber === null ||
        reconciliation.blockNumber === "" ||
        reconciliation.evidence === null ||
        typeof reconciliation.evidence !== "object"
      ) {
        return { state: "BLOCKED", code: "RECONCILIATION_PROVENANCE_MISSING" };
      }
      if (now - reconciliation.createdAt.getTime() > this.reconciliationMaxAgeMs) {
        return { state: "NOT_READY", code: "RECONCILIATION_STALE" };
      }
    }

    return { state: "READY", code: "RECONCILIATION_MATCHED" };
  }

  private getCustody(): Promise<{
    ready: boolean;
    gasReady: boolean;
    code: string;
    gasCode?: string;
  }> {
    if (this.custodyResult === undefined) {
      this.custodyResult = this.custody!.checkReadiness();
    }
    return this.custodyResult;
  }

  private async checkCustody(payoutsEnabled: boolean): Promise<ProbeOutcome> {
    if (!payoutsEnabled) return { state: "READY", code: "PAYOUTS_DISABLED" };
    if (!this.custody) return { state: "BLOCKED", code: "PROBE_UNCONFIGURED" };
    const result = await this.getCustody();
    return result.ready
      ? { state: "READY", code: "CUSTODY_READY" }
      : { state: "BLOCKED", code: result.code };
  }

  private async checkNativeGas(payoutsEnabled: boolean): Promise<ProbeOutcome> {
    if (!payoutsEnabled) return { state: "READY", code: "PAYOUTS_DISABLED" };
    if (!this.custody) return { state: "BLOCKED", code: "PROBE_UNCONFIGURED" };
    const result = await this.getCustody();
    return result.gasReady
      ? { state: "READY", code: "NATIVE_GAS_OK" }
      : { state: "NOT_READY", code: result.gasCode ?? "NATIVE_GAS_LOW" };
  }

  private async checkFreeze(): Promise<ProbeOutcome> {
    if (!this.freeze) return { state: "READY", code: "FREEZE_NONE" };
    const state = await this.freeze.getState();
    return state.frozen
      ? { state: "NOT_READY", code: state.code }
      : { state: "READY", code: "NOT_FROZEN" };
  }

  // --------------------------------------------------------------------------
  // Canonical financial projection
  // --------------------------------------------------------------------------

  private buildFinancialReadiness(checks: PlatformReadinessCheck[]): FinancialReadiness {
    const financialChecks = checks.filter((check) => FINANCIAL_CHECK_NAMES.includes(check.name));
    const state = worstState(financialChecks.map((check) => check.state));

    const reasons: ReadinessReason[] = [];
    for (const check of financialChecks) {
      if (check.state === "READY") continue;
      const reason = FINANCIAL_CHECK_REASON[check.name];
      if (reason !== undefined && !reasons.includes(reason)) reasons.push(reason);
    }

    return FinancialReadinessSchema.parse({
      state,
      reasons,
      checks: financialChecks.map((check) => ({
        name: check.name,
        state: check.state,
        latencyMs: check.latencyMs,
        detail: check.detail,
      })),
    });
  }
}
