/**
 * Real PostgreSQL DI harness for the canonical private custody withdrawal
 * workflow.
 *
 * Wires the actual `WithdrawalWorkflow` from
 * `packages/custody/src/core/withdrawal-workflow.ts` with:
 *   - the durable Prisma custody stores (`PrismaWithdrawalStore`,
 *     `PrismaIncidentStore`, `PrismaAssetRegistry`) over the fresh acceptance
 *     PostgreSQL, and
 *   - the real viem ports: `ViemTreasurySigner`, `ViemQuorumReader`,
 *     `ViemTreasuryBroadcaster` against the live Anvil chain.
 *
 * The accounting port is the real `AtomicLedger`-backed implementation in
 * `prisma-accounting.ts`. Every value movement is a real ERC-20 transaction and
 * every liability change is a real balanced journal posting.
 *
 * A fresh harness over the same `prisma`/`databaseUrl` is a genuine process
 * restart: it reads only PostgreSQL and creates new store objects. The harness
 * exposes broadcaster/quorum decorators that inject the exact fault the
 * acceptance scenario requires (accepted-but-dropped response, reorged-away
 * receipt, missing-receipt reorg) without touching the workflow implementation.
 */
import type { Address, Hex } from "viem";
import type { AssetStatus } from "@pokertools/types";
import type { PrismaClient } from "../../../../api/generated/prisma/index.js";
import {
  PrismaAssetRegistry,
  PrismaIncidentStore,
  PrismaWithdrawalStore,
} from "../../../../custody/src/core/prisma-store.js";
import {
  ViemQuorumReader,
  ViemTreasuryBroadcaster,
  ViemTreasurySigner,
  staticAccountResolver,
} from "../../../../custody/src/core/viem-ports.js";
import {
  WithdrawalWorkflow,
  type WithdrawalWorkflowConfig,
} from "../../../../custody/src/core/withdrawal-workflow.js";
import type {
  Clock,
  QuorumResult,
  RpcQuorumReader,
  ReceiptObservation,
  TreasuryAccounting,
  TreasuryAsset,
  TreasuryBroadcaster,
} from "../../../../custody/src/core/types.js";
import { createPrismaTreasuryAccounting } from "./prisma-accounting.js";

export const TEST_CLOCK: Clock = { now: () => Date.now() };

const QUIET_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface CustodyHarnessOptions {
  prisma: PrismaClient;
  databaseUrl: string;
  chainId: number;
  rpcUrls: string[];
  tokenAddress: Address;
  treasuryAddress: Address;
  treasuryPrivateKey: Hex;
  minGasAtomic?: string;
  confirmations?: number;
  deepFinality?: number;
  quorumThreshold?: number;
  /** Workflow-level agreeing-observation floor. Defaults to quorumThreshold. */
  minQuorum?: number;
  assetStatus?: AssetStatus;
  broadcaster?: TreasuryBroadcaster;
  quorum?: RpcQuorumReader;
  accounting?: TreasuryAccounting;
  config?: Partial<WithdrawalWorkflowConfig>;
}

export interface CustodyHarness {
  workflow: WithdrawalWorkflow;
  store: PrismaWithdrawalStore;
  incidents: PrismaIncidentStore;
  assets: PrismaAssetRegistry;
  accounting: TreasuryAccounting;
  asset: TreasuryAsset;
}

export function buildCustodyHarness(options: CustodyHarnessOptions): CustodyHarness {
  const asset: TreasuryAsset = {
    assetId: `eip155:${options.chainId}/erc20:${options.tokenAddress.toLowerCase()}`,
    chainId: options.chainId,
    tokenAddress: options.tokenAddress,
    treasuryAddress: options.treasuryAddress,
    rpcUrls: [...options.rpcUrls],
    minGasAtomic: options.minGasAtomic ?? "0",
    confirmations: options.confirmations ?? 1,
    deepFinality: options.deepFinality ?? 3,
    status: options.assetStatus ?? "ACTIVE",
  };

  const store = new PrismaWithdrawalStore(options.prisma, options.databaseUrl);
  const incidents = new PrismaIncidentStore(options.prisma);
  const assets = new PrismaAssetRegistry(options.prisma);
  const accounting = options.accounting ?? createPrismaTreasuryAccounting(options.prisma);

  const quorum =
    options.quorum ??
    new ViemQuorumReader({ threshold: options.quorumThreshold ?? 1, retryCount: 0 });
  const signer = new ViemTreasurySigner(
    staticAccountResolver(new Map([[options.chainId, options.treasuryPrivateKey]]))
  );
  const broadcaster = options.broadcaster ?? new ViemTreasuryBroadcaster();

  const workflow = new WithdrawalWorkflow({
    store,
    incidents,
    assets,
    accounting,
    signer,
    quorum,
    broadcaster,
    clock: TEST_CLOCK,
    logger: QUIET_LOGGER,
    config: {
      minQuorum: options.minQuorum ?? options.quorumThreshold ?? 1,
      ...options.config,
    },
  });

  return { workflow, store, incidents, assets, accounting, asset };
}

/**
 * Broadcaster that forwards to the real node (so the transaction IS accepted)
 * and then throws — modelling an accepted broadcast with a dropped response.
 */
export function acceptedButDroppedBroadcaster(
  message = "simulated dropped response"
): TreasuryBroadcaster {
  const real = new ViemTreasuryBroadcaster();
  return {
    async broadcast(asset: TreasuryAsset, rawTransaction: Hex) {
      await real.broadcast(asset, rawTransaction);
      throw new Error(message);
    },
  };
}

/**
 * Quorum decorator that treats a genuinely missing receipt as `{ value: null }`
 * (an explicit reorg signal) instead of a transport/quorum failure. Only
 * "not found"-style errors are converted; other errors pass through untouched.
 */
export function reorgAwareQuorum(real: RpcQuorumReader): RpcQuorumReader {
  return {
    nativeBalance: (asset, address) => real.nativeBalance(asset, address),
    erc20BalanceOf: (asset, owner) => real.erc20BalanceOf(asset, owner),
    transactionCount: (asset, address, tag) => real.transactionCount(asset, address, tag),
    block: (asset, blockNumber) => real.block(asset, blockNumber),
    blockNumber: (asset) => real.blockNumber(asset),
    async transactionReceipt(
      asset: TreasuryAsset,
      hash: string
    ): Promise<QuorumResult<ReceiptObservation | null>> {
      const result = await real.transactionReceipt(asset, hash);
      if (!result.agreed && result.observations.length === 0 && result.errors.length > 0) {
        const allMissing = result.errors.every((error) =>
          /could not be found|not found|no receipt/i.test(error.message)
        );
        if (allMissing) {
          // A quorum that agrees the receipt is absent must still carry one
          // observation per queried endpoint: the workflow treats an empty
          // observation set as a transport failure, and a genuine missing
          // receipt as a reorg signal.
          return {
            agreed: true,
            value: null,
            observations: result.errors.map((error) => ({ rpcUrl: error.rpcUrl, value: null })),
            errors: [],
          };
        }
      }
      return result;
    },
  };
}
