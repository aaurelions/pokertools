/**
 * ChainRegistry-backed custody read adapter.
 *
 * The custody package owns its narrow `RpcQuorumReader` port and must not
 * depend on API implementation types. This module adapts the canonical
 * `ChainRegistry` quorum reader to a structurally identical surface so the
 * custody runtime can consume validated, multi-endpoint chain facts without
 * importing `@pokertools/api` types into its own port definitions.
 *
 * Properties:
 *  - Every fact is served through the registry's validated endpoint quorum.
 *  - A receipt that is absent from every endpoint is a valid unanimous
 *    observation (`agreed: true, value: null`), which the custody workflow
 *    treats as "receipt missing" and re-checks. Transport/quorum failures are
 *    reported as `agreed: false` so an RPC outage is never mistaken for a
 *    reorg.
 *  - Endpoint URLs (which may embed credentials) are never copied into the
 *    synthetic observations surfaced to custody; only stable labels are used.
 *  - Confirmation height comes from `getSettlementBlockNumber`, never a
 *    single fallback endpoint.
 */

import type { PrismaClient } from "../../generated/prisma/index.js";
import {
  buildChainRegistryFromAssets,
  createPrismaChainFreezeHandler,
  createPrismaIncidentSink,
  type BuildRegistryOptions,
} from "./canonical-deposit-verifier.js";
import {
  ChainFrozenError,
  RpcEndpointError,
  RpcQuorumError,
  parseErc20Transfer,
  type NormalizedBlock,
  type NormalizedReceipt,
  type RegistryLogger,
} from "./chain-registry.js";

// ---------------------------------------------------------------------------
// Structural contracts (mirror the custody port shapes)
// ---------------------------------------------------------------------------

export interface CustodyAssetLike {
  assetId: string;
  chainId: number;
  tokenAddress?: string;
  treasuryAddress?: string;
}

export interface CustodyBlockObservation {
  number: number;
  hash: string;
  parentHash: string;
}

export interface CustodyTransferLog {
  tokenAddress: string;
  from: string;
  to: string;
  amountAtomic: string;
  logIndex: number;
  txHash: string;
}

export interface CustodyReceiptObservation {
  status: "success" | "reverted";
  blockNumber: number;
  blockHash: string;
  transfers: CustodyTransferLog[];
}

export interface CustodyQuorumResult<T> {
  agreed: boolean;
  value: T | null;
  observations: Array<{ rpcUrl: string; value: T }>;
  errors: Array<{ rpcUrl: string; message: string }>;
}

export type CustodyBlockTag = "latest" | "pending";

/**
 * Minimal read surface of `ChainRegistry`. Kept structural so tests can inject
 * a fake and so this module never imports the concrete class just for typing.
 */
export interface CustodyChainRegistryLike {
  getTransactionReceipt(chainId: number, txHash: string): Promise<NormalizedReceipt | null>;
  getBlock(
    chainId: number,
    ref: { blockNumber: bigint } | { blockHash: string }
  ): Promise<NormalizedBlock>;
  getSettlementBlockNumber(chainId: number): Promise<bigint>;
  getBalance(chainId: number, address: string): Promise<bigint>;
  getTokenBalance(chainId: number, token: string, owner: string): Promise<bigint>;
  getTransactionCount(
    chainId: number,
    address: string,
    blockTag?: CustodyBlockTag
  ): Promise<bigint>;
  isChainAuthorized(chainId: number): boolean;
  getEndpoints?(chainId: number): Array<{ id: string; url: string }>;
}

export interface CustodyQuorumReader {
  nativeBalance(asset: CustodyAssetLike, address: string): Promise<CustodyQuorumResult<bigint>>;
  erc20BalanceOf(asset: CustodyAssetLike, owner: string): Promise<CustodyQuorumResult<bigint>>;
  transactionCount(
    asset: CustodyAssetLike,
    address: string,
    blockTag: CustodyBlockTag
  ): Promise<CustodyQuorumResult<number>>;
  transactionReceipt(
    asset: CustodyAssetLike,
    hash: string
  ): Promise<CustodyQuorumResult<CustodyReceiptObservation | null>>;
  block(
    asset: CustodyAssetLike,
    blockNumber: number
  ): Promise<CustodyQuorumResult<CustodyBlockObservation>>;
  blockNumber(asset: CustodyAssetLike): Promise<CustodyQuorumResult<number>>;
}

export interface CreateCustodyQuorumReaderOptions {
  /** Minimum agreeing observations demanded by the custody workflow. Default 2. */
  minFanout?: number;
}

function stableError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "UNKNOWN";
}

function endpointLabel(registry: CustodyChainRegistryLike, chainId: number, index: number): string {
  const endpoints = registry.getEndpoints?.(chainId) ?? [];
  const endpoint = endpoints[index];
  return endpoint ? `endpoint:${endpoint.id}` : `endpoint:${index}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapt a `ChainRegistry` (or structural equivalent) to the custody quorum
 * port. `agreed` results synthesize one observation per configured endpoint so
 * the custody workflow's independent-observation count is preserved without
 * leaking endpoint URLs.
 */
export function createCustodyQuorumReader(
  registry: CustodyChainRegistryLike,
  options: CreateCustodyQuorumReaderOptions = {}
): CustodyQuorumReader {
  const minFanout = options.minFanout ?? 2;

  function fanout(chainId: number): number {
    const count = registry.getEndpoints?.(chainId).length ?? 0;
    return Math.max(minFanout, count);
  }

  function agree<T>(chainId: number, value: T): CustodyQuorumResult<T> {
    const count = fanout(chainId);
    const observations = Array.from({ length: count }, (_, index) => ({
      rpcUrl: endpointLabel(registry, chainId, index),
      value,
    }));
    return { agreed: true, value, observations, errors: [] };
  }

  function disagree<T>(chainId: number, error: unknown): CustodyQuorumResult<T> {
    return {
      agreed: false,
      value: null,
      observations: [],
      errors: [{ rpcUrl: endpointLabel(registry, chainId, 0), message: stableError(error) }],
    };
  }

  return {
    async nativeBalance(asset, address) {
      try {
        return agree(asset.chainId, await registry.getBalance(asset.chainId, address));
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },

    async erc20BalanceOf(asset, owner) {
      const token = asset.tokenAddress;
      if (!token) return disagree(asset.chainId, new Error("asset token address missing"));
      try {
        return agree(asset.chainId, await registry.getTokenBalance(asset.chainId, token, owner));
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },

    async transactionCount(asset, address, blockTag) {
      try {
        const value = await registry.getTransactionCount(asset.chainId, address, blockTag);
        return agree(asset.chainId, Number(value));
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },

    async transactionReceipt(asset, hash) {
      try {
        const receipt = await registry.getTransactionReceipt(asset.chainId, hash);
        if (receipt === null) {
          // Unanimous absence is a valid observation; the workflow decides
          // whether that is a reorg (already-confirmed) or a rebroadcast.
          const result = agree<CustodyReceiptObservation | null>(asset.chainId, null);
          return { ...result, value: null };
        }
        return agree(asset.chainId, mapReceipt(receipt));
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },

    async block(asset, blockNumber) {
      try {
        const block = await registry.getBlock(asset.chainId, {
          blockNumber: BigInt(blockNumber),
        });
        return agree(asset.chainId, {
          number: Number(block.number),
          hash: block.hash,
          parentHash: block.parentHash,
        });
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },

    async blockNumber(asset) {
      try {
        const height = await registry.getSettlementBlockNumber(asset.chainId);
        return agree(asset.chainId, Number(height));
      } catch (error) {
        return disagree(asset.chainId, error);
      }
    },
  };
}

function mapReceipt(receipt: NormalizedReceipt): CustodyReceiptObservation {
  const transfers: CustodyTransferLog[] = [];
  for (const log of receipt.logs) {
    const parsed = parseErc20Transfer(log);
    if (!parsed) continue;
    transfers.push({
      tokenAddress: log.address,
      from: parsed.from,
      to: parsed.to,
      amountAtomic: parsed.amount.toString(),
      logIndex: log.logIndex,
      txHash: receipt.transactionHash,
    });
  }
  return {
    status: receipt.status,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    transfers,
  };
}

// ---------------------------------------------------------------------------
// Asset-backed wiring
// ---------------------------------------------------------------------------

export interface AssetBackedCustodyQuorumReaderOptions {
  logger?: RegistryLogger;
  quorum?: BuildRegistryOptions["quorum"];
  resolveHost?: BuildRegistryOptions["resolveHost"];
  createClient?: BuildRegistryOptions["createClient"];
  minFanout?: number;
}

/**
 * Lazily build a `ChainRegistry` per persisted asset route, including frozen
 * routes so restarts can still monitor signed obligations and reconciliation.
 * and expose it through the custody quorum port. Registry construction
 * failures fail closed per read (`agreed: false`) rather than throwing into a
 * signing path. The workflow separately rejects new signing on frozen routes.
 */
export function createAssetBackedCustodyQuorumReader(
  prisma: Pick<PrismaClient, "asset" | "financialIncident">,
  options: AssetBackedCustodyQuorumReaderOptions = {}
): CustodyQuorumReader {
  // Synthetic redacted observation labels must never claim a stronger vote
  // floor than the registry actually enforces. Higher floors need an explicit
  // matching threshold; the default majority over >=2 endpoints guarantees 2.
  if ((options.minFanout ?? 2) > (options.quorum ?? 2)) {
    throw new RangeError("Custody minimum observations exceed the configured RPC quorum");
  }
  const registries = new Map<string, ReturnType<typeof buildChainRegistryFromAssets>>();

  const getRegistry = async (asset: CustodyAssetLike): Promise<ChainRegistryLike> => {
    let registry = registries.get(asset.assetId);
    if (registry && (await registry).isFrozen(asset.chainId)) {
      // This port only observes. Durable Asset.status still blocks new signing;
      // fresh validated reads must remain possible for existing obligations and
      // the reconciliation needed for operator resolution.
      if (registries.get(asset.assetId) === registry) {
        registries.delete(asset.assetId);
        registry = undefined;
      } else {
        registry = registries.get(asset.assetId);
      }
    }
    registry ??= buildChainRegistryFromAssets(prisma, {
      assetId: asset.assetId,
      observeFrozen: true,
      logger: options.logger,
      ...(options.quorum !== undefined ? { quorum: options.quorum } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      ...(options.createClient ? { createClient: options.createClient } : {}),
      incidentSink: createPrismaIncidentSink(prisma),
      onFreeze: createPrismaChainFreezeHandler(prisma),
    });
    registries.set(asset.assetId, registry);
    try {
      return await registry;
    } catch (error) {
      if (registries.get(asset.assetId) === registry) registries.delete(asset.assetId);
      throw error;
    }
  };

  // A read fails closed when the registry could not be constructed. The
  // failing reader produces `agreed: false` for every method with a stable
  // error name and never touches the signing path.
  const fail = (error: unknown): Promise<never> =>
    Promise.reject(error instanceof Error ? error : new Error("custody registry unavailable"));
  const failingReader = (error: unknown): CustodyQuorumReader =>
    createCustodyQuorumReader(
      {
        getTransactionReceipt: () => fail(error),
        getBlock: () => fail(error),
        getSettlementBlockNumber: () => fail(error),
        getBalance: () => fail(error),
        getTokenBalance: () => fail(error),
        getTransactionCount: () => fail(error),
        isChainAuthorized: () => false,
        getEndpoints: () => [] as Array<{ id: string; url: string }>,
      },
      { minFanout: options.minFanout ?? 2 }
    );

  const withRegistry = async <T>(
    asset: CustodyAssetLike,
    read: (reader: CustodyQuorumReader) => Promise<T>
  ): Promise<T> => {
    let reader: CustodyQuorumReader;
    try {
      reader = createCustodyQuorumReader(await getRegistry(asset), {
        minFanout: options.minFanout,
      });
    } catch (error) {
      reader = failingReader(error);
    }
    return read(reader);
  };

  return {
    nativeBalance: (asset, address) =>
      withRegistry(asset, (reader) => reader.nativeBalance(asset, address)),
    erc20BalanceOf: (asset, owner) =>
      withRegistry(asset, (reader) => reader.erc20BalanceOf(asset, owner)),
    transactionCount: (asset, address, blockTag) =>
      withRegistry(asset, (reader) => reader.transactionCount(asset, address, blockTag)),
    transactionReceipt: (asset, hash) =>
      withRegistry(asset, (reader) => reader.transactionReceipt(asset, hash)),
    block: (asset, blockNumber) =>
      withRegistry(asset, (reader) => reader.block(asset, blockNumber)),
    blockNumber: (asset) => withRegistry(asset, (reader) => reader.blockNumber(asset)),
  };
}

/** Structural alias used by the runtime to avoid importing the class type. */
type ChainRegistryLike = CustodyChainRegistryLike;

// Re-exported so callers can map registry errors without importing the module.
export { ChainFrozenError, RpcEndpointError, RpcQuorumError };
