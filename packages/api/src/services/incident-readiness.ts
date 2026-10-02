/**
 * Incident resolution readiness check (operator-safe unfreeze gate).
 *
 * The finance incident service requires a fail-closed `IncidentReadinessCheck`
 * before an incident can be resolved and a route returned to ACTIVE. This
 * module builds the real check for the API process:
 *
 *  - a fresh, MATCHED treasury reconciliation must exist for the asset
 *    (reconciliation is produced by the custody worker through the canonical
 *    accounting port),
 *  - the asset's chain must have a validated endpoint quorum,
 *  - settlement-height, treasury token-balance and native-gas reads must all
 *    succeed through that quorum,
 *  - native gas must meet the asset's conservative configured floor.
 *
 * Every failure throws a stable 503 machine code. Raw RPC URLs / upstream
 * errors are never surfaced or logged here; the registry already keeps its own
 * redacted evidence.
 */

import type { PrismaClient } from "../../generated/prisma/index.js";
import type { IncidentReadinessCheck } from "./financial-incidents.js";
import { AppError } from "../utils/errors.js";
import { parseAssetRpcUrls } from "./canonical-deposit-verifier.js";
import { ChainRegistry } from "./chain-registry.js";

export const DEFAULT_MAX_RECONCILIATION_AGE_MS = 30 * 60_000;
export const DEFAULT_REGISTRY_TTL_MS = 5 * 60_000;

export class IncidentReadinessError extends AppError {
  constructor(code: string, message: string) {
    super(message, 503, code);
  }
}

export interface IncidentReadinessOptions {
  prisma: PrismaClient;
  /** Reconciliation older than this is not evidence. Default 30 minutes. */
  maxReconciliationAgeMs?: number;
  /** Registry cache lifetime. Default 5 minutes. */
  registryTtlMs?: number;
  /** Injection seam for tests. */
  registryFactory?: () => Promise<ChainRegistry>;
  now?: () => number;
}

export function createIncidentReadinessCheck(
  options: IncidentReadinessOptions
): IncidentReadinessCheck {
  const maxReconciliationAgeMs =
    options.maxReconciliationAgeMs ?? DEFAULT_MAX_RECONCILIATION_AGE_MS;
  const registryTtlMs = options.registryTtlMs ?? DEFAULT_REGISTRY_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, { registry: ChainRegistry; createdAt: number }>();

  /**
   * Build a validated registry from an explicit chain/endpoint set. This is
   * deliberately independent of `Asset.status`: an incident freeze must not
   * disable observation, and resolution has to be able to verify the frozen
   * route before it can be returned to ACTIVE.
   */
  async function getRegistryFor(
    cacheKey: string,
    chainId: number,
    urls: string[]
  ): Promise<ChainRegistry> {
    const current = now();
    const hit = cache.get(cacheKey);
    if (hit && current - hit.createdAt < registryTtlMs) return hit.registry;

    if (options.registryFactory) {
      const registry = await options.registryFactory();
      cache.set(cacheKey, { registry, createdAt: current });
      return registry;
    }

    if (urls.length < 2) {
      throw new IncidentReadinessError(
        "RPC_QUORUM_UNVERIFIED",
        "At least two independent RPC endpoints are required"
      );
    }

    try {
      const registry = new ChainRegistry({
        endpoints: urls.map((url, index) => ({
          id: `incident-${chainId}-${index}`,
          chainId,
          url,
        })),
      });
      await registry.start();
      cache.set(cacheKey, { registry, createdAt: current });
      return registry;
    } catch {
      cache.delete(cacheKey);
      throw new IncidentReadinessError(
        "RPC_QUORUM_UNVERIFIED",
        "Chain registry is not healthy for incident resolution"
      );
    }
  }

  return async (tx, incident) => {
    // Chain-level incident without a single asset: still require a validated
    // quorum for the chain and a healthy settlement height. Endpoints are
    // gathered from every asset on the chain regardless of freeze state.
    if (!incident.assetId) {
      if (incident.chainId === null) return;
      const chainAssets = await tx.asset.findMany({
        where: { chainId: incident.chainId },
        select: { rpcUrls: true },
      });
      const urls = [
        ...new Set(chainAssets.flatMap((asset) => parseAssetRpcUrls(asset.rpcUrls))),
      ].sort();
      const registry = await getRegistryFor(`chain:${incident.chainId}`, incident.chainId, urls);
      if (!registry.isChainAuthorized(incident.chainId)) {
        throw new IncidentReadinessError(
          "RPC_QUORUM_UNVERIFIED",
          "Chain does not have a validated endpoint quorum"
        );
      }
      try {
        await registry.getSettlementBlockNumber(incident.chainId);
      } catch {
        throw new IncidentReadinessError(
          "RPC_QUORUM_UNVERIFIED",
          "Chain settlement height is not quorum-verified"
        );
      }
      return;
    }

    const asset = await tx.asset.findUnique({
      where: { id: incident.assetId },
      select: {
        id: true,
        chainId: true,
        tokenAddress: true,
        treasuryAddress: true,
        minGasAtomic: true,
        status: true,
        rpcUrls: true,
      },
    });
    if (!asset) {
      throw new IncidentReadinessError("ASSET_UNKNOWN", "Incident asset does not exist");
    }

    const reconciliation = await tx.treasuryReconciliation.findFirst({
      where: { assetId: asset.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, createdAt: true },
    });
    const cutoff = now() - maxReconciliationAgeMs;
    if (
      !reconciliation ||
      reconciliation.status !== "MATCHED" ||
      reconciliation.createdAt.getTime() < cutoff
    ) {
      throw new IncidentReadinessError(
        "RECONCILIATION_UNVERIFIED",
        "A fresh matched treasury reconciliation is required"
      );
    }

    const urls = [...new Set(parseAssetRpcUrls(asset.rpcUrls))].sort();
    const registry = await getRegistryFor(`asset:${asset.id}`, asset.chainId, urls);
    if (!registry.isChainAuthorized(asset.chainId)) {
      throw new IncidentReadinessError(
        "RPC_QUORUM_UNVERIFIED",
        "Asset chain does not have a validated endpoint quorum"
      );
    }

    try {
      await registry.getSettlementBlockNumber(asset.chainId);
      await registry.getTokenBalance(asset.chainId, asset.tokenAddress, asset.treasuryAddress);
      const nativeGas = await registry.getBalance(asset.chainId, asset.treasuryAddress);
      let minimumGas: bigint;
      try {
        minimumGas = BigInt(asset.minGasAtomic);
      } catch {
        throw new IncidentReadinessError(
          "NATIVE_GAS_UNVERIFIED",
          "Asset native-gas policy is not a valid atomic amount"
        );
      }
      if (nativeGas < minimumGas) {
        throw new IncidentReadinessError(
          "NATIVE_GAS_UNVERIFIED",
          "Treasury native gas is below the configured conservative floor"
        );
      }
    } catch (error) {
      if (error instanceof IncidentReadinessError) throw error;
      throw new IncidentReadinessError(
        "RPC_QUORUM_UNVERIFIED",
        "Quorum chain reads failed during incident resolution"
      );
    }
  };
}
