/**
 * On-chain verification half of the canonical direct-treasury deposit flow.
 *
 * The finance-core `CanonicalDepositService` owns the durable, idempotent credit
 * path; it delegates every chain fact to a `DepositClaimVerifier`. This module
 * builds that verifier on top of `ChainRegistry` quorum reads.
 *
 * Security properties:
 *  - The client supplies only `(assetId, txHash, logIndex)`; the amount,
 *    recipient, confirmations and provenance are re-derived from chain state.
 *  - The ERC20 `Transfer` sender is bound to the authenticated wallet and the
 *    recipient to the asset's treasury address.
 *  - The receipt must be successful, its log index exact, its token exact, and
 *    its block canonical against the block quorum before the claim is verified.
 *  - RPC infrastructure failure is thrown (mapped to 503 by the route) and never
 *    treated as a proof of a reverted or non-canonical deposit.
 */

import type { PrismaClient } from "../../generated/prisma/index.js";
import type {
  DepositClaimVerification,
  DepositClaimVerificationInput,
  DepositClaimVerifier,
} from "./canonical-deposits.js";
import {
  ChainRegistry,
  RpcEndpointError,
  RpcQuorumError,
  type ChainRegistryOptions,
  type QuorumReader,
  type RegistryIncident,
  type RegistryLogger,
  parseErc20Transfer,
} from "./chain-registry.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Asset RPC configuration parsing (operator-managed `Asset.rpcUrls`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract HTTP RPC URLs from an asset's `rpcUrls` JSON. Accepts:
 *  - `["https://a", "https://b"]`
 *  - `[{ id?, url }, ...]`
 *  - `{ endpoints: [...] }`
 */
export function parseAssetRpcUrls(rpcUrls: unknown): string[] {
  if (typeof rpcUrls === "string") return [rpcUrls];
  if (Array.isArray(rpcUrls)) {
    const urls: string[] = [];
    for (const entry of rpcUrls) {
      if (typeof entry === "string") {
        urls.push(entry);
      } else if (isRecord(entry) && typeof entry.url === "string") {
        urls.push(entry.url);
      }
    }
    return urls;
  }
  if (isRecord(rpcUrls) && Array.isArray(rpcUrls.endpoints)) {
    return parseAssetRpcUrls(rpcUrls.endpoints);
  }
  return [];
}

export interface BuildRegistryOptions {
  logger?: RegistryLogger;
  incidentSink?: ChainRegistryOptions["incidentSink"];
  onFreeze?: ChainRegistryOptions["onFreeze"];
  quorum?: number;
  resolveHost?: ChainRegistryOptions["resolveHost"];
  createClient?: ChainRegistryOptions["createClient"];
}

/**
 * Build and start a `ChainRegistry` from the enabled assets' `rpcUrls`.
 * Endpoints are deduplicated per chain; the registry enforces at least two
 * independent participants per chain.
 */
export async function buildChainRegistryFromAssets(
  prisma: Pick<PrismaClient, "asset">,
  options: BuildRegistryOptions = {}
): Promise<ChainRegistry> {
  const assets = await prisma.asset.findMany({
    where: { status: { in: ["ACTIVE", "DEGRADED"] } },
    select: { id: true, chainId: true, rpcUrls: true },
  });

  const byChain = new Map<number, Set<string>>();
  for (const asset of assets) {
    const urls = parseAssetRpcUrls(asset.rpcUrls);
    if (urls.length === 0) continue;
    const set = byChain.get(asset.chainId) ?? new Set<string>();
    for (const url of urls) set.add(url);
    byChain.set(asset.chainId, set);
  }

  const endpoints = [];
  for (const [chainId, urls] of [...byChain.entries()].sort(([a], [b]) => a - b)) {
    let index = 0;
    for (const url of urls) {
      endpoints.push({ id: `chain-${chainId}-${index++}`, chainId, url });
    }
  }

  const registry = new ChainRegistry({
    endpoints,
    ...(options.quorum !== undefined ? { quorum: options.quorum } : {}),
    ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
    ...(options.createClient ? { createClient: options.createClient } : {}),
    incidentSink: options.incidentSink,
    onFreeze: options.onFreeze,
    logger: options.logger,
  });
  await registry.start();
  return registry;
}

// ---------------------------------------------------------------------------
// Prisma-backed incident sink / freeze handler
// ---------------------------------------------------------------------------

export interface DepositVerifierPrisma {
  asset: {
    findUnique(args: unknown): Promise<{
      id: string;
      chainId: number;
      tokenAddress: string;
      treasuryAddress: string;
      confirmations: number;
      status: string;
    } | null>;
    findMany(args?: unknown): Promise<Array<{ id: string; chainId: number; rpcUrls: unknown }>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  financialIncident: {
    create(args: unknown): Promise<{ id: string }>;
  };
}

export function createPrismaIncidentSink(
  prisma: Pick<PrismaClient, "financialIncident">
): NonNullable<ChainRegistryOptions["incidentSink"]> {
  return {
    async record(incident: RegistryIncident): Promise<void> {
      await prisma.financialIncident.create({
        data: {
          // The durable IncidentKind enum carries RPC_DISAGREEMENT as a
          // first-class kind; persist it verbatim so an operator can query the
          // mandatory disagreement incident directly. The original kind is also
          // mirrored into evidence for redundancy.
          kind: incident.kind,
          severity: incident.severity,
          status: incident.status,
          chainId: incident.chainId,
          evidence: {
            ...incident.evidence,
            reportedKind: incident.kind,
            disagreement: incident.kind === "RPC_DISAGREEMENT",
          },
        },
      });
    },
  };
}

export function createPrismaChainFreezeHandler(
  prisma: Pick<PrismaClient, "asset">
): NonNullable<ChainRegistryOptions["onFreeze"]> {
  return async (chainId: number): Promise<void> => {
    await prisma.asset.updateMany({ where: { chainId }, data: { status: "FROZEN" } });
  };
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface CanonicalDepositVerifierDeps {
  prisma: DepositVerifierPrisma;
  /** Resolves (and memoizes) the started registry. */
  getRegistry: () => Promise<QuorumReader>;
  logger?: RegistryLogger;
}

function reject(reason: string): DepositClaimVerification {
  return { verified: false, reason };
}

export function createCanonicalDepositVerifier(
  deps: CanonicalDepositVerifierDeps
): DepositClaimVerifier {
  return async (input: DepositClaimVerificationInput): Promise<DepositClaimVerification> => {
    if (!input.walletAddress) return reject("WALLET_REQUIRED");

    const asset = await deps.prisma.asset.findUnique({ where: { id: input.assetId } });
    if (!asset) return reject("ASSET_NOT_FOUND");
    if (asset.status === "FROZEN") return reject("ASSET_FROZEN");
    if (asset.chainId !== input.chainId) return reject("ASSET_MISMATCH");

    // RPC/registry infrastructure failures are thrown so the route can map them
    // to 503; they are never interpreted as a negative on-chain result.
    const registry = await deps.getRegistry();
    if (!registry.isChainAuthorized(asset.chainId)) return reject("CHAIN_NOT_AUTHORIZED");

    const txHash = input.txHash.toLowerCase();
    const canonical = await registry.getCanonicalReceipt(asset.chainId, txHash);
    if (!canonical) return reject("RECEIPT_NOT_FOUND");

    const { receipt, confirmations } = canonical;
    if (receipt.transactionHash !== txHash) return reject("TX_MISMATCH");
    if (receipt.status !== "success") return reject("TX_NOT_SUCCESS");

    const log = receipt.logs.find((candidate) => candidate.logIndex === input.logIndex);
    if (!log) return reject("LOG_NOT_FOUND");

    const transfer = parseErc20Transfer(log);
    if (!transfer) return reject("NOT_ERC20_TRANSFER");
    if (log.address.toLowerCase() !== asset.tokenAddress.toLowerCase())
      return reject("WRONG_TOKEN");
    if (transfer.from === ZERO_ADDRESS) return reject("MINT_TRANSFER");
    if (transfer.from !== input.walletAddress.toLowerCase()) return reject("WRONG_SENDER");
    if (transfer.to !== asset.treasuryAddress.toLowerCase()) return reject("WRONG_RECIPIENT");
    if (transfer.amount <= 0n) return reject("ZERO_AMOUNT");
    if (confirmations < asset.confirmations) return reject("INSUFFICIENT_CONFIRMATIONS");

    return {
      verified: true,
      amountAtomic: transfer.amount.toString(),
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      confirmations,
      provenance: "DIRECT_TREASURY",
    };
  };
}

export interface AssetBackedVerifierOptions {
  prisma: PrismaClient;
  logger?: RegistryLogger;
  quorum?: number;
  resolveHost?: ChainRegistryOptions["resolveHost"];
  createClient?: ChainRegistryOptions["createClient"];
}

/**
 * Production wiring: builds the registry from assets on first use, persists RPC
 * incidents, and freezes every asset on a chain when the registry freezes it.
 */
export function createAssetBackedDepositVerifier(
  options: AssetBackedVerifierOptions
): DepositClaimVerifier {
  let registryPromise: Promise<ChainRegistry> | null = null;

  const getRegistry = (): Promise<ChainRegistry> => {
    if (!registryPromise) {
      registryPromise = buildChainRegistryFromAssets(options.prisma, {
        logger: options.logger,
        quorum: options.quorum,
        resolveHost: options.resolveHost,
        createClient: options.createClient,
        incidentSink: createPrismaIncidentSink(options.prisma),
        onFreeze: createPrismaChainFreezeHandler(options.prisma),
      });
    }
    return registryPromise;
  };

  return createCanonicalDepositVerifier({
    prisma: options.prisma,
    getRegistry,
    logger: options.logger,
  });
}

// Re-exported so worker/bootstrap code can map infrastructure errors uniformly.
export { RpcEndpointError, RpcQuorumError };
