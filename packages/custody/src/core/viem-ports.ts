/**
 * viem-backed implementations of the custody signing and broadcast ports.
 *
 * RPC quorum reads are intentionally NOT implemented here: the production
 * runtime uses the API-owned `createAssetBackedCustodyQuorumReader`
 * (validated ChainRegistry quorum, fail-closed) as the single authoritative
 * `RpcQuorumReader`. This module only owns the treasury signer, the raw-bytes
 * broadcaster and the private-key account resolver.
 *
 * Durable signing rule: unsigned gas/fee inputs are accepted only when every
 * one of >= 2 distinct configured RPC endpoints independently reports the same
 * chain id, gas estimate, fee model/fields and native balance. Any endpoint
 * error, chain-id mismatch, value dissent or unaffordable worst-case cost fails
 * closed; the workflow keeps the obligation and retries later. Outlier fees are
 * never majority-voted, and persisted signed bytes are never re-signed.
 */
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type TransactionSerializableLegacy,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type {
  SignedTransaction,
  SignTransferRequest,
  TreasuryAsset,
  TreasuryBroadcaster,
  TreasurySigner,
} from "./types.js";
import type { EvmAddress, TxHash } from "@pokertools/types";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

interface Eip1559FeeEstimate {
  model: "eip1559";
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface LegacyFeeEstimate {
  model: "legacy";
  gasPrice: bigint;
}

type FeeEstimate = Eip1559FeeEstimate | LegacyFeeEstimate;

/** One endpoint's unsigned signing inputs. */
interface RpcSigningEstimate {
  chainId: number;
  gas: bigint;
  fee: FeeEstimate;
  nativeBalance: bigint;
}

/** Exact agreement key: fee model and every fee field must match. */
function feeKey(fee: FeeEstimate): string {
  return fee.model === "eip1559"
    ? `eip1559:${fee.maxFeePerGas.toString()}:${fee.maxPriorityFeePerGas.toString()}`
    : `legacy:${fee.gasPrice.toString()}`;
}

/** Worst-case per-gas price actually bound into the signed transaction. */
function worstFeePerGas(fee: FeeEstimate): bigint {
  return fee.model === "eip1559" ? fee.maxFeePerGas : fee.gasPrice;
}

function buildChain(chainId: number, rpcUrls: string[]) {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
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

  private client(chainId: number, rpcUrl: string): PublicClient {
    const key = `${chainId}:${rpcUrl}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const client = createPublicClient({
      chain: buildChain(chainId, [rpcUrl]),
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    this.clients.set(key, client);
    return client;
  }

  /**
   * Observe one endpoint's unsigned signing inputs. Only the treasury address
   * (never private key material) is sent to the RPC. Per-endpoint sanity is
   * enforced here; cross-endpoint agreement is enforced by `signTransfer`.
   */
  private async observeEndpoint(
    chainId: number,
    rpcUrl: string,
    treasuryAddress: EvmAddress,
    tokenAddress: EvmAddress,
    data: `0x${string}`
  ): Promise<RpcSigningEstimate> {
    const client = this.client(chainId, rpcUrl);
    const observedChainId = await client.getChainId();
    if (observedChainId !== chainId) {
      throw new Error("Treasury signer: RPC chain id mismatch");
    }

    const [gas, fees, nativeBalance] = await Promise.all([
      client.estimateGas({
        account: treasuryAddress as `0x${string}`,
        to: tokenAddress as `0x${string}`,
        data,
        value: 0n,
      }),
      client.estimateFeesPerGas(),
      client.getBalance({ address: treasuryAddress as `0x${string}` }),
    ]);

    let fee: FeeEstimate;
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      fee = {
        model: "eip1559",
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    } else {
      fee = {
        model: "legacy",
        gasPrice: fees.gasPrice ?? (await client.getGasPrice()),
      };
    }

    if (gas <= 0n) throw new Error("Treasury signer: non-positive gas estimate");
    if (fee.model === "eip1559") {
      if (fee.maxFeePerGas <= 0n) {
        throw new Error("Treasury signer: non-positive maxFeePerGas");
      }
      if (fee.maxPriorityFeePerGas < 0n || fee.maxPriorityFeePerGas > fee.maxFeePerGas) {
        throw new Error("Treasury signer: maxPriorityFeePerGas exceeds maxFeePerGas");
      }
    } else if (fee.gasPrice <= 0n) {
      throw new Error("Treasury signer: non-positive gasPrice");
    }

    return { chainId: observedChainId, gas, fee, nativeBalance };
  }

  async signTransfer(request: SignTransferRequest): Promise<SignedTransaction> {
    const account = await this.accounts.resolve(request.chainId, request.treasuryAddress);
    if (account.address.toLowerCase() !== request.treasuryAddress.toLowerCase()) {
      throw new Error(
        `Treasury signer address ${account.address} does not control ${request.treasuryAddress}`
      );
    }

    // Signed bytes are immutable once persisted, so a single RPC must never
    // dictate fee/gas inputs: require at least two distinct endpoints.
    const distinctRpcUrls = [
      ...new Set(request.rpcUrls.map((rpcUrl) => rpcUrl.trim()).filter((rpcUrl) => rpcUrl !== "")),
    ];
    if (distinctRpcUrls.length < 2) {
      throw new Error("Treasury signer: at least 2 distinct RPC URLs are required");
    }

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [request.destination as `0x${string}`, BigInt(request.amountAtomic)],
    });

    const settled = await Promise.allSettled(
      distinctRpcUrls.map((rpcUrl) =>
        this.observeEndpoint(request.chainId, rpcUrl, account.address, request.tokenAddress, data)
      )
    );
    const failures = settled.filter((result) => result.status === "rejected").length;
    if (failures > 0) {
      // Never include transport messages: they may embed credential URLs.
      throw new Error(
        `Treasury signer: RPC observation failed on ${failures}/${distinctRpcUrls.length} endpoints`
      );
    }

    const estimates = settled.map(
      (result) => (result as PromiseFulfilledResult<RpcSigningEstimate>).value
    );
    const reference = estimates[0];
    for (const estimate of estimates) {
      if (
        estimate.chainId !== reference.chainId ||
        estimate.gas !== reference.gas ||
        estimate.nativeBalance !== reference.nativeBalance ||
        feeKey(estimate.fee) !== feeKey(reference.fee)
      ) {
        // No majority vote: one dissenting outlier fails closed.
        throw new Error("Treasury signer: RPC signing estimates dissented");
      }
    }

    // The only spend bound is the agreed native balance (no fixed policy
    // constants): worst-case gas * fee must be affordable.
    if (reference.gas * worstFeePerGas(reference.fee) > reference.nativeBalance) {
      throw new Error("Treasury signer: worst-case gas cost exceeds the agreed native balance");
    }

    let transaction: TransactionSerializableEIP1559 | TransactionSerializableLegacy;
    if (reference.fee.model === "eip1559") {
      transaction = {
        chainId: request.chainId,
        to: request.tokenAddress as `0x${string}`,
        data,
        nonce: request.nonce,
        value: 0n,
        gas: reference.gas,
        maxFeePerGas: reference.fee.maxFeePerGas,
        maxPriorityFeePerGas: reference.fee.maxPriorityFeePerGas,
        type: "eip1559",
      };
    } else {
      transaction = {
        chainId: request.chainId,
        to: request.tokenAddress as `0x${string}`,
        data,
        nonce: request.nonce,
        value: 0n,
        gas: reference.gas,
        gasPrice: reference.fee.gasPrice,
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
    // Key by chainId as well as URL: the same endpoint may serve multiple
    // chains, and a cached client pinned to the wrong chain would broadcast
    // the exact signed bytes against the wrong network.
    const key = `${asset.chainId}:${rpcUrl}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const client = createPublicClient({
      chain: buildChain(asset.chainId, asset.rpcUrls),
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    this.clients.set(key, client);
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
