/**
 * viem-backed implementations of the custody ports (RPC quorum, signer,
 * broadcaster).
 *
 * The quorum reader is conservative: it observes every configured RPC and only
 * reports agreement when the configured threshold of nodes return the same
 * value. Any per-RPC failure is surfaced in `errors` and makes the decision
 * non-agreed, which the workflow treats as fail-closed.
 */
import {
  createPublicClient,
  defineChain,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type TransactionSerializableLegacy,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type {
  BlockObservation,
  BlockTag,
  QuorumResult,
  ReceiptObservation,
  RpcObservation,
  RpcQuorumReader,
  SignedTransaction,
  SignTransferRequest,
  TransferLogObservation,
  TreasuryAsset,
  TreasuryBroadcaster,
  TreasurySigner,
} from "./types.js";
import type { EvmAddress, TxHash } from "@pokertools/types";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const TRANSFER_EVENT = "Transfer(address,address,uint256)";

export interface ViemQuorumConfig {
  /** Nodes that must agree on a value to form a quorum. */
  threshold: number;
  requestTimeoutMs?: number;
  retryCount?: number;
}

function buildChain(chainId: number, rpcUrls: string[]) {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
}

function canonicalize(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" || typeof value === "boolean") {
    return `${typeof value}:${value.toString()}`;
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "symbol") return `symbol:${value.description ?? ""}`;
  return JSON.stringify(value) ?? "unserializable";
}

export class ViemQuorumReader implements RpcQuorumReader {
  private readonly clients = new Map<string, PublicClient>();
  private readonly threshold: number;
  private readonly requestTimeoutMs: number;
  private readonly retryCount: number;

  constructor(config: ViemQuorumConfig) {
    this.threshold = config.threshold;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.retryCount = config.retryCount ?? 2;
  }

  private clientFor(asset: TreasuryAsset, rpcUrl: string): PublicClient {
    const key = `${asset.chainId}:${rpcUrl}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const client = createPublicClient({
      chain: buildChain(asset.chainId, asset.rpcUrls),
      transport: http(rpcUrl, {
        timeout: this.requestTimeoutMs,
        retryCount: this.retryCount,
      }),
    });
    this.clients.set(key, client);
    return client;
  }

  private async observe<T>(
    asset: TreasuryAsset,
    read: (client: PublicClient) => Promise<T>
  ): Promise<QuorumResult<T>> {
    const observations: Array<RpcObservation<T>> = [];
    const errors: Array<{ rpcUrl: string; message: string }> = [];
    await Promise.all(
      asset.rpcUrls.map(async (rpcUrl) => {
        try {
          const value = await read(this.clientFor(asset, rpcUrl));
          observations.push({ rpcUrl, value });
        } catch (error) {
          errors.push({
            rpcUrl,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    const groups = new Map<string, Array<RpcObservation<T>>>();
    for (const observation of observations) {
      const key = canonicalize(observation.value);
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length >= this.threshold) {
        return { agreed: true, value: group[0].value, observations, errors };
      }
    }
    return { agreed: false, value: null, observations, errors };
  }

  async nativeBalance(asset: TreasuryAsset, address: EvmAddress): Promise<QuorumResult<bigint>> {
    return this.observe(asset, (client) =>
      client.getBalance({ address: address as `0x${string}` })
    );
  }

  async erc20BalanceOf(asset: TreasuryAsset, owner: EvmAddress): Promise<QuorumResult<bigint>> {
    return this.observe(asset, (client) =>
      client.readContract({
        address: asset.tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [owner as `0x${string}`],
      })
    );
  }

  async transactionCount(
    asset: TreasuryAsset,
    address: EvmAddress,
    blockTag: BlockTag
  ): Promise<QuorumResult<number>> {
    return this.observe(asset, (client) =>
      client.getTransactionCount({ address: address as `0x${string}`, blockTag })
    );
  }

  async transactionReceipt(
    asset: TreasuryAsset,
    hash: TxHash
  ): Promise<QuorumResult<ReceiptObservation | null>> {
    return this.observe(asset, async (client) => {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      } catch (error) {
        // Unanimous absence is a valid observation ("receipt missing"), not an
        // outage. Any other error must fail the endpoint's observation.
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      if (!receipt) return null;
      const transfers: TransferLogObservation[] = [];
      for (const log of receipt.logs) {
        if (log.topics[0]?.toLowerCase() !== transferTopic()) continue;
        try {
          const decoded = decodeEventLog({
            abi: ERC20_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== "Transfer") continue;
          const args = decoded.args;
          transfers.push({
            tokenAddress: log.address,
            from: args.from,
            to: args.to,
            amountAtomic: args.value.toString(),
            logIndex: log.logIndex ?? 0,
            txHash: log.transactionHash ?? hash,
          });
        } catch {
          // Non-matching log; ignore.
        }
      }
      return {
        status: receipt.status === "success" ? "success" : "reverted",
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        transfers,
      } satisfies ReceiptObservation;
    });
  }

  async block(asset: TreasuryAsset, blockNumber: number): Promise<QuorumResult<BlockObservation>> {
    return this.observe(asset, async (client) => {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
      return {
        number: Number(block.number ?? 0n),
        hash: block.hash,
        parentHash: block.parentHash,
      } satisfies BlockObservation;
    });
  }

  async blockNumber(asset: TreasuryAsset): Promise<QuorumResult<number>> {
    return this.observe(asset, async (client) => Number(await client.getBlockNumber()));
  }
}

/** keccak256("Transfer(address,address,uint256)") computed once. */
let transferTopicCache: `0x${string}` | null = null;
function transferTopic(): `0x${string}` {
  transferTopicCache ??= keccak256(new TextEncoder().encode(TRANSFER_EVENT));
  return transferTopicCache;
}

export interface TreasuryAccountResolver {
  /** Resolve the signing account that controls the treasury address on a chain. */
  resolve(
    chainId: number,
    treasuryAddress: EvmAddress
  ): Promise<PrivateKeyAccount> | PrivateKeyAccount;
}

export class ViemTreasurySigner implements TreasurySigner {
  private readonly clients = new Map<string, PublicClient>();

  constructor(private readonly accounts: TreasuryAccountResolver) {}

  private client(chainId: number, rpcUrls: string[]): PublicClient {
    const rpcUrl = rpcUrls[0];
    if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`);
    const key = `${chainId}:${rpcUrl}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const client = createPublicClient({
      chain: buildChain(chainId, rpcUrls),
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    this.clients.set(key, client);
    return client;
  }

  async signTransfer(request: SignTransferRequest): Promise<SignedTransaction> {
    const account = await this.accounts.resolve(request.chainId, request.treasuryAddress);
    if (account.address.toLowerCase() !== request.treasuryAddress.toLowerCase()) {
      throw new Error(
        `Treasury signer address ${account.address} does not control ${request.treasuryAddress}`
      );
    }

    const client = this.client(request.chainId, request.rpcUrls);
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [request.destination as `0x${string}`, BigInt(request.amountAtomic)],
    });

    const gas = await client.estimateGas({
      account,
      to: request.tokenAddress as `0x${string}`,
      data,
      value: 0n,
    });
    const fees = await client.estimateFeesPerGas();

    let transaction: TransactionSerializableEIP1559 | TransactionSerializableLegacy;
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      transaction = {
        chainId: request.chainId,
        to: request.tokenAddress as `0x${string}`,
        data,
        nonce: request.nonce,
        value: 0n,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: "eip1559",
      };
    } else {
      transaction = {
        chainId: request.chainId,
        to: request.tokenAddress as `0x${string}`,
        data,
        nonce: request.nonce,
        value: 0n,
        gas,
        gasPrice: fees.gasPrice ?? (await client.getGasPrice()),
        type: "legacy",
      };
    }

    const rawTransaction = await account.signTransaction(transaction);
    return {
      rawTransaction,
      hash: keccak256(rawTransaction),
      provenance: {
        chainId: request.chainId,
        to: request.tokenAddress,
        valueAtomic: "0",
        nonce: request.nonce,
        callData: data,
        destination: request.destination,
        amountAtomic: request.amountAtomic,
      },
    };
  }
}

export class ViemTreasuryBroadcaster implements TreasuryBroadcaster {
  private readonly clients = new Map<string, PublicClient>();

  private client(asset: TreasuryAsset): PublicClient {
    const rpcUrl = asset.rpcUrls[0];
    if (!rpcUrl) throw new Error(`Asset ${asset.assetId} has no RPC URLs`);
    const cached = this.clients.get(rpcUrl);
    if (cached) return cached;
    const client = createPublicClient({
      chain: buildChain(asset.chainId, asset.rpcUrls),
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    this.clients.set(rpcUrl, client);
    return client;
  }

  async broadcast(asset: TreasuryAsset, rawTransaction: `0x${string}`): Promise<TxHash> {
    return this.client(asset).sendRawTransaction({ serializedTransaction: rawTransaction });
  }
}

/** Build an account resolver from a single hex private key per chain (custody-only). */
export function staticAccountResolver(
  accountsByChain: Map<number, `0x${string}`>
): TreasuryAccountResolver {
  const cache = new Map<number, PrivateKeyAccount>();
  return {
    resolve(chainId: number): PrivateKeyAccount {
      const cached = cache.get(chainId);
      if (cached) return cached;
      const key = accountsByChain.get(chainId);
      if (!key) throw new Error(`No treasury signing key configured for chain ${chainId}`);
      const account = privateKeyToAccount(key);
      cache.set(chainId, account);
      return account;
    },
  };
}
