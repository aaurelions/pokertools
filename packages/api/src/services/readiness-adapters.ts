import type { PrismaClient } from "../../generated/prisma/index.js";
import {
  AssetIdSchema,
  EvmAddressSchema,
  ReadinessResponseSchema,
  type ReadinessResponse,
} from "@pokertools/types";
import {
  MAX_ASSETS_VERIFIED,
  PlatformReadinessService,
  type ChainQuorumProbe,
  type CustodyReadinessProbe,
  type LedgerIntegrityProbe,
  type PlatformReadinessReport,
  type QueueHealthProbe,
  type RedisHealthProbe,
} from "./platform-readiness.js";
import { AtomicLedger, LedgerInvariantError } from "./atomic-ledger.js";
import { FinancialIncidentService } from "./financial-incidents.js";
import {
  ChainFrozenError,
  RpcChainMismatchError,
  RpcDisagreementError,
  RpcDuplicateEndpointError,
  RpcEndpointError,
  RpcQuorumError,
  type ChainRegistryOptions,
  type IncidentSink,
  type RegistryIncident,
  type RegistryLogger,
} from "./chain-registry.js";
import { buildChainRegistryFromAssets } from "./canonical-deposit-verifier.js";

/**
 * Production readiness adapters.
 *
 * `platform-readiness.ts` is transport-free and probe-injected. This module is
 * the only place that binds those probes to real infrastructure:
 *
 *  - Redis `PING` and BullMQ queue counts,
 *  - `AtomicLedger` journal/projection invariants over real Prisma state,
 *  - `ChainRegistry` endpoint topology validation + settlement/block/custody
 *    quorum reads built from `Asset.rpcUrls` (URL pools are deduplicated per
 *    chain, so an endpoint shared by several assets is one participant),
 *  - durable `FinancialIncidentService` records for RPC disagreement and route
 *    freeze,
 *  - durable external-worker custody/gas heartbeat evidence.
 *
 * Fail-closed rules:
 *  - The API never reads signer keys. Custody readiness may only come from
 *    recent durable external-worker evidence; there is no default reader and
 *    no inference from reconciliation, matched or otherwise.
 *  - Payouts are considered enabled whenever a canonical `Asset` row exists,
 *    unless the caller explicitly opts into public non-financial mode.
 */

// ---------------------------------------------------------------------------
// Minimal structural contracts (avoids importing ioredis/bullmq types here)
// ---------------------------------------------------------------------------

export interface RedisPingLike {
  ping(): Promise<string>;
}

export interface BullQueueLike {
  getJobCounts(): Promise<Record<string, number>>;
}

export interface PlatformReadinessApp {
  prisma: PrismaClient;
  redis: RedisPingLike;
  queue: BullQueueLike;
}

// ---------------------------------------------------------------------------
// Redis / queue
// ---------------------------------------------------------------------------

export function createRedisHealthProbe(redis: RedisPingLike): RedisHealthProbe {
  return {
    async check() {
      try {
        const pong = await redis.ping();
        return pong === "PONG"
          ? { ok: true, code: "REDIS_OK" }
          : { ok: false, code: "REDIS_UNEXPECTED_RESPONSE" };
      } catch {
        return { ok: false, code: "REDIS_UNREACHABLE" };
      }
    },
  };
}

export interface QueueHealthProbeOptions {
  /** Failed-job backlog that is considered unhealthy. Default 100. */
  failedThreshold?: number;
}

export function createQueueHealthProbe(
  queue: BullQueueLike,
  options: QueueHealthProbeOptions = {}
): QueueHealthProbe {
  const failedThreshold = options.failedThreshold ?? 100;
  return {
    async check() {
      try {
        const counts = await queue.getJobCounts();
        const failed = Number(counts.failed ?? 0);
        const waiting = Number(counts.waiting ?? 0);
        if (failed > failedThreshold) {
          return { ok: false, code: "QUEUE_FAILED_BACKLOG", failed, waiting };
        }
        return { ok: true, code: "QUEUE_OK", failed, waiting };
      } catch {
        return { ok: false, code: "QUEUE_UNREACHABLE" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger invariants / projection
// ---------------------------------------------------------------------------

/**
 * Read-only invariant/projection inspection over every configured asset using
 * `AtomicLedger.assertAssetBalanced` (balanced sealed journals, per-asset
 * net-zero, nonnegative user accounts, cache == journal sums). Never mutates
 * history or triggers `rebuild()`.
 */
export function createAtomicLedgerReadinessProbe(
  prisma: PrismaClient,
  ledger: AtomicLedger
): LedgerIntegrityProbe {
  return {
    async verify() {
      const assets = await prisma.asset.findMany({
        take: MAX_ASSETS_VERIFIED + 1,
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (assets.length > MAX_ASSETS_VERIFIED) {
        return { ok: false, code: "LEDGER_ASSET_LIMIT_EXCEEDED" };
      }
      for (const asset of assets) {
        try {
          await ledger.assertAssetBalanced(prisma, asset.id);
        } catch (error) {
          // The invariant error already identifies the invariant; its message
          // may name rows, so it is never surfaced.
          if (error instanceof LedgerInvariantError) {
            return { ok: false, code: "LEDGER_INVARIANT_FAILURE" };
          }
          return { ok: false, code: "LEDGER_CHECK_FAILURE" };
        }
      }
      return { ok: true, code: "LEDGER_OK" };
    },
  };
}

// ---------------------------------------------------------------------------
// RPC quorum
// ---------------------------------------------------------------------------

export interface ChainRegistryReadinessProbeOptions {
  prisma: PrismaClient;
  incidents: FinancialIncidentService;
  logger?: RegistryLogger;
  quorum?: ChainRegistryOptions["quorum"];
  resolveHost?: ChainRegistryOptions["resolveHost"];
  createClient?: ChainRegistryOptions["createClient"];
}

/** Map a registry/client failure to a stable, non-leaking readiness code. */
export function mapRegistryError(error: unknown): string {
  if (error instanceof RpcDisagreementError) return "RPC_DISAGREEMENT";
  if (error instanceof RpcQuorumError) return "RPC_QUORUM_FAILURE";
  if (error instanceof ChainFrozenError) return "CHAIN_FROZEN";
  if (error instanceof RpcChainMismatchError) return "RPC_CHAIN_MISMATCH";
  if (error instanceof RpcDuplicateEndpointError) return "RPC_DUPLICATE_ENDPOINT";
  if (error instanceof RpcEndpointError) return "RPC_ENDPOINT_INVALID";
  return "RPC_READ_FAILED";
}

/** Persist RPC disagreement/quorum failure through the durable incident service. */
export function createReadinessIncidentSink(incidents: FinancialIncidentService): IncidentSink {
  return {
    async record(incident: RegistryIncident): Promise<void> {
      await incidents.open({
        kind: incident.kind,
        severity: "CRITICAL",
        chainId: incident.chainId,
        evidence: {
          ...incident.evidence,
          reportedKind: incident.kind,
          disagreement: incident.kind === "RPC_DISAGREEMENT",
        },
      });
    },
  };
}

/**
 * Freeze every asset on a chain after the registry froze it. The freeze itself
 * and its durable incident are recorded through `FinancialIncidentService`; no
 * economic algorithm is reimplemented here.
 */
export function createReadinessChainFreezeHandler(
  _prisma: Pick<PrismaClient, "asset">,
  incidents: FinancialIncidentService
): NonNullable<ChainRegistryOptions["onFreeze"]> {
  return async (chainId: number, evidence): Promise<void> => {
    // Open the durable incident and freeze every asset on the chain in ONE
    // transaction (all assets locked in sorted order) so no new financial risk
    // can be admitted in the gap between incident creation and route freeze.
    await incidents.openCriticalIncidentAndFreeze({
      kind: "CUSTODY_FAILURE",
      severity: "CRITICAL",
      chainId,
      evidence: { ...evidence, routeFreeze: true },
      freezeChainWide: true,
    });
  };
}

/**
 * Build a quorum probe over `Asset.rpcUrls`. The registry construction
 * validates chain ids, rejects duplicate endpoint pools and enforces at least
 * two independent participants per chain. For each configured chain the probe
 * reads a quorum-bounded settlement height, the canonical block at that height,
 * the treasury native balance (gas) and the treasury token balance.
 */
export function createChainRegistryReadinessProbe(
  options: ChainRegistryReadinessProbeOptions
): ChainQuorumProbe {
  let registryPromise: Promise<Awaited<ReturnType<typeof buildChainRegistryFromAssets>>> | null =
    null;

  const getRegistry = (): Promise<Awaited<ReturnType<typeof buildChainRegistryFromAssets>>> => {
    if (registryPromise === null) {
      registryPromise = buildChainRegistryFromAssets(options.prisma, {
        logger: options.logger,
        quorum: options.quorum,
        resolveHost: options.resolveHost,
        createClient: options.createClient,
        incidentSink: createReadinessIncidentSink(options.incidents),
        onFreeze: createReadinessChainFreezeHandler(options.prisma, options.incidents),
      }).catch((error: unknown) => {
        // A transient startup failure must not pin the process to BLOCKED;
        // the next evaluation rebuilds and retries.
        registryPromise = null;
        throw error;
      });
    }
    return registryPromise;
  };

  return {
    async verifyQuorum() {
      let registry: Awaited<ReturnType<typeof buildChainRegistryFromAssets>>;
      try {
        registry = await getRegistry();
      } catch (error) {
        return { ok: false, code: mapRegistryError(error) };
      }

      const chains = registry.getChainIds();
      if (chains.length === 0) return { ok: false, code: "RPC_NO_CHAINS" };

      const assets = await options.prisma.asset.findMany({
        where: { status: { in: ["ACTIVE", "DEGRADED"] }, chainId: { in: chains } },
        select: { chainId: true, tokenAddress: true, treasuryAddress: true },
      });

      // Deduplicate custody reads within a chain: one (chain, token) pair and
      // one native-balance read per treasury address.
      const tokensByChain = new Map<
        number,
        Map<string, { treasuryAddress: string; tokenAddress: string }>
      >();
      for (const asset of assets) {
        const tokens = tokensByChain.get(asset.chainId) ?? new Map();
        if (!tokens.has(asset.tokenAddress)) {
          tokens.set(asset.tokenAddress, {
            treasuryAddress: asset.treasuryAddress,
            tokenAddress: asset.tokenAddress,
          });
        }
        tokensByChain.set(asset.chainId, tokens);
      }

      try {
        for (const chainId of chains) {
          if (!registry.isChainAuthorized(chainId)) {
            return { ok: false, code: "RPC_CHAIN_UNAUTHORIZED" };
          }
          if (registry.isFrozen(chainId)) {
            return { ok: false, code: "CHAIN_FROZEN" };
          }

          const settlement = await registry.getSettlementBlockNumber(chainId);
          await registry.getBlock(chainId, { blockNumber: settlement });

          const tokens = tokensByChain.get(chainId);
          if (tokens !== undefined) {
            const treasuries = new Set<string>();
            for (const { treasuryAddress, tokenAddress } of tokens.values()) {
              if (!treasuries.has(treasuryAddress)) {
                treasuries.add(treasuryAddress);
                await registry.getBalance(chainId, treasuryAddress);
              }
              await registry.getTokenBalance(chainId, tokenAddress, treasuryAddress);
            }
          }
        }
      } catch (error) {
        return { ok: false, code: mapRegistryError(error) };
      }

      return { ok: true, code: "RPC_QUORUM_OK", chainsChecked: chains.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Durable external-worker custody / gas evidence
// ---------------------------------------------------------------------------

/**
 * One durable heartbeat persisted by the external custody worker.
 *
 * The API selects fresh evidence per chain/treasury route. Heartbeats contain
 * only public addresses, never signing keys. Missing readers fail closed.
 */
export interface CustodyHeartbeatRecord {
  chainId: number;
  /** Public signer address. The API must never persist or receive key material. */
  signerAddress: string;
  signerReady: boolean;
  gasReady: boolean;
  observedAt: Date;
  workerId: string;
}

export interface CustodyHeartbeatReader {
  read(): Promise<CustodyHeartbeatRecord[]>;
}

/** Fail-closed fallback when no durable reader is supplied. */
export class UnavailableCustodyEvidenceReader implements CustodyHeartbeatReader {
  async read(): Promise<CustodyHeartbeatRecord[]> {
    return [];
  }
}

export interface DurableCustodyEvidenceProbeOptions {
  prisma: Pick<PrismaClient, "asset">;
  reader?: CustodyHeartbeatReader;
  /** Maximum heartbeat age. Default 5 minutes. */
  maxAgeMs?: number;
  now?: () => number;
}

export function createDurableCustodyEvidenceProbe(
  options: DurableCustodyEvidenceProbeOptions
): CustodyReadinessProbe {
  const reader = options.reader ?? new UnavailableCustodyEvidenceReader();
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());

  return {
    async checkReadiness() {
      const assets = await options.prisma.asset.findMany({
        select: { chainId: true, treasuryAddress: true },
      });
      if (assets.length === 0) {
        return {
          ready: false,
          gasReady: false,
          code: "CUSTODY_NO_ASSETS",
          gasCode: "CUSTODY_NO_ASSETS",
        };
      }
      const expectedRoutes = new Set(
        assets.map((asset) => `${asset.chainId}:${asset.treasuryAddress.toLowerCase()}`)
      );

      let heartbeats: CustodyHeartbeatRecord[];
      try {
        heartbeats = await reader.read();
      } catch {
        return {
          ready: false,
          gasReady: false,
          code: "CUSTODY_EVIDENCE_UNREADABLE",
          gasCode: "CUSTODY_EVIDENCE_UNREADABLE",
        };
      }
      if (heartbeats.length === 0) {
        return {
          ready: false,
          gasReady: false,
          code: "CUSTODY_EVIDENCE_MISSING",
          gasCode: "CUSTODY_EVIDENCE_MISSING",
        };
      }

      const checkedAt = now();
      const cutoff = checkedAt - maxAgeMs;
      const latestByRoute = new Map<string, CustodyHeartbeatRecord>();
      for (const heartbeat of heartbeats) {
        if (!(heartbeat.observedAt instanceof Date)) continue;
        const timestamp = heartbeat.observedAt.getTime();
        if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > checkedAt + 1000)
          continue;
        if (!EvmAddressSchema.safeParse(heartbeat.signerAddress).success) continue;
        const route = `${heartbeat.chainId}:${heartbeat.signerAddress}`;
        const previous = latestByRoute.get(route);
        if (
          !previous ||
          timestamp > previous.observedAt.getTime() ||
          (timestamp === previous.observedAt.getTime() &&
            (!heartbeat.signerReady || !heartbeat.gasReady))
        ) {
          latestByRoute.set(route, heartbeat);
        }
      }

      let gasReady = true;
      for (const route of expectedRoutes) {
        const heartbeat = latestByRoute.get(route);
        if (!heartbeat || !heartbeat.signerReady) {
          return {
            ready: false,
            gasReady: false,
            code: "CUSTODY_HEARTBEAT_MISSING",
            gasCode: "CUSTODY_HEARTBEAT_MISSING",
          };
        }
        gasReady = gasReady && heartbeat.gasReady;
      }

      if (!gasReady)
        return { ready: true, gasReady: false, code: "CUSTODY_READY", gasCode: "NATIVE_GAS_LOW" };
      return { ready: true, gasReady: true, code: "CUSTODY_READY" };
    },
  };
}

// ---------------------------------------------------------------------------
// Wire mapping
// ---------------------------------------------------------------------------

/** Map the internal report to the transport `ReadinessResponse` contract. */
export function buildReadinessResponse(report: PlatformReadinessReport): ReadinessResponse {
  return ReadinessResponseSchema.parse({
    status: report.ready ? "ready" : "not_ready",
    timestamp: report.timestamp,
    checks: report.checks.map((check) => ({
      name: check.name,
      state: check.state,
      mandatory: check.mandatory,
      latencyMs: check.latencyMs,
      detail: check.detail,
    })),
    financial: report.financial,
  });
}

// ---------------------------------------------------------------------------
// Payout gating + composition root
// ---------------------------------------------------------------------------

/** True when at least one canonical `eip155:<id>/erc20:<addr>` asset is configured. */
export async function hasConfiguredCanonicalAsset(
  prisma: Pick<PrismaClient, "asset">
): Promise<boolean> {
  const assets = await prisma.asset.findMany({
    take: MAX_ASSETS_VERIFIED + 1,
    orderBy: { id: "asc" },
    select: { id: true },
  });
  // Beyond the bound we cannot prove absence; fail closed.
  if (assets.length > MAX_ASSETS_VERIFIED) return true;
  return assets.some((asset) => AssetIdSchema.safeParse(asset.id).success);
}

export interface CreatePlatformReadinessOptions {
  elapsedNow?: () => number;
  /**
   * Explicit public, non-financial deployment. Supports only when no canonical
   * asset carries value; payouts/custody gating is then disabled. This is a
   * deliberate caller decision, never an environment variable.
   */
  publicNonFinancialMode?: boolean;
  /** Whole-report cache TTL. Default 5s so `/ready` does not scan RPC each call. */
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  reconciliationMaxAgeMs?: number;
  reconciliationRequired?: boolean;
  rpcQuorumRequired?: boolean;
  outboxMaxPendingAgeMs?: number;
  outboxMaxAttempts?: number;
  now?: () => number;
  nodeEnv?: string;
  databaseUrl?: string;
  /** Chain registry wiring (mostly for tests; production uses Asset.rpcUrls). */
  quorum?: ChainRegistryOptions["quorum"];
  resolveHost?: ChainRegistryOptions["resolveHost"];
  createClient?: ChainRegistryOptions["createClient"];
  registryLogger?: RegistryLogger;
  /** Durable external-worker evidence for custody/gas. Defaults to none. */
  custodyEvidenceReader?: CustodyHeartbeatReader;
  custodyEvidenceMaxAgeMs?: number;
  // Explicit override seams; the defaults below are the real implementations.
  ledger?: AtomicLedger;
  incidents?: FinancialIncidentService;
  ledgerProbe?: LedgerIntegrityProbe;
  chainQuorum?: ChainQuorumProbe;
  custody?: CustodyReadinessProbe;
}

/**
 * Composition root for the API. Wires live infrastructure and financial probes.
 */
export function createPlatformReadiness(
  app: PlatformReadinessApp,
  options: CreatePlatformReadinessOptions = {}
): PlatformReadinessService {
  const ledger = options.ledger ?? new AtomicLedger(app.prisma);
  const incidents = options.incidents ?? new FinancialIncidentService(app.prisma, ledger);

  return new PlatformReadinessService({
    prisma: app.prisma,
    redis: createRedisHealthProbe(app.redis),
    queue: createQueueHealthProbe(app.queue),
    ledger: options.ledgerProbe ?? createAtomicLedgerReadinessProbe(app.prisma, ledger),
    chainQuorum:
      options.chainQuorum ??
      createChainRegistryReadinessProbe({
        prisma: app.prisma,
        incidents,
        logger: options.registryLogger,
        quorum: options.quorum,
        resolveHost: options.resolveHost,
        createClient: options.createClient,
      }),
    custody:
      options.custody ??
      createDurableCustodyEvidenceProbe({
        prisma: app.prisma,
        reader: options.custodyEvidenceReader,
        maxAgeMs: options.custodyEvidenceMaxAgeMs,
        now: options.now,
      }),
    cacheTtlMs: options.cacheTtlMs ?? 5_000,
    elapsedNow: options.elapsedNow,
    probeTimeoutMs: options.probeTimeoutMs,
    now: options.now,
    nodeEnv: options.nodeEnv,
    databaseUrl: options.databaseUrl,
    // Payouts are enabled whenever a canonical asset exists. Only an explicit
    // public non-financial decision disables financial gating.
    payoutsEnabled: async () =>
      !options.publicNonFinancialMode && (await hasConfiguredCanonicalAsset(app.prisma)),
    reconciliationRequired: options.reconciliationRequired,
    reconciliationMaxAgeMs: options.reconciliationMaxAgeMs,
    rpcQuorumRequired: options.rpcQuorumRequired,
    outboxMaxPendingAgeMs: options.outboxMaxPendingAgeMs,
    outboxMaxAttempts: options.outboxMaxAttempts,
  });
}
