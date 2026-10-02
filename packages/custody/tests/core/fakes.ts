import { keccak256 } from "viem";
import type {
  AssetStatus,
  BlockObservation,
  BlockTag,
  Clock,
  CustodyLogger,
  QuorumResult,
  ReceiptObservation,
  RpcQuorumReader,
  RpcObservation,
  SignedTransaction,
  SignedTransactionProvenance,
  SignTransferRequest,
  TransferLogObservation,
  TreasuryAsset,
  TreasuryBroadcaster,
  TreasurySigner,
} from "../../src/core/types.js";

export const CHAIN_ID = 31337;
export const TOKEN = "0x00000000000000000000000000000000000000aa";
export const TREASURY = "0x00000000000000000000000000000000000000bb";
export const DESTINATION = "0x00000000000000000000000000000000000000cc";
export const OTHER_DESTINATION = "0x00000000000000000000000000000000000000dd";
export const ASSET_ID = `eip155:${CHAIN_ID}/erc20:${TOKEN}`;
export const RPC_URLS = ["http://rpc-a.example", "http://rpc-b.example"];

export const ASSET: TreasuryAsset = {
  assetId: ASSET_ID,
  chainId: CHAIN_ID,
  tokenAddress: TOKEN,
  treasuryAddress: TREASURY,
  rpcUrls: RPC_URLS,
  minGasAtomic: "1000",
  confirmations: 3,
  deepFinality: 6,
  status: "ACTIVE",
};

export class FakeClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function quietLogger(): CustodyLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

function quorum<T>(value: T, agreed: boolean): QuorumResult<T> {
  const observations: Array<RpcObservation<T>> = agreed
    ? RPC_URLS.map((rpcUrl) => ({ rpcUrl, value }))
    : [{ rpcUrl: RPC_URLS[0], value }];
  return {
    agreed,
    value: agreed ? value : null,
    observations,
    errors: agreed ? [] : [{ rpcUrl: RPC_URLS[1], message: "unavailable" }],
  };
}

export class FakeQuorumReader implements RpcQuorumReader {
  nativeBalanceAtomic = 10_000n;
  nativeAgreed = true;
  nonce = 0;
  nonceAgreed = true;
  receipt: ReceiptObservation | null = null;
  receiptAgreed = true;
  /** Quorum-bounded head height returned by `blockNumber`. */
  blockHeight = 0;
  blockAgreed = true;
  /** Canonical block hash override; defaults to the observed receipt's hash. */
  canonicalBlockHash: string | null = null;
  canonicalBlockAgreed = true;

  async nativeBalance(): Promise<QuorumResult<bigint>> {
    return quorum(this.nativeBalanceAtomic, this.nativeAgreed);
  }

  async erc20BalanceOf(): Promise<QuorumResult<bigint>> {
    return quorum(this.nativeBalanceAtomic, this.nativeAgreed);
  }

  async transactionCount(
    _asset: TreasuryAsset,
    _address: string,
    _blockTag: BlockTag
  ): Promise<QuorumResult<number>> {
    return quorum(this.nonce, this.nonceAgreed);
  }

  async transactionReceipt(): Promise<QuorumResult<ReceiptObservation | null>> {
    return quorum(this.receipt, this.receiptAgreed);
  }

  async block(_asset: TreasuryAsset, blockNumber: number): Promise<QuorumResult<BlockObservation>> {
    const hash = this.canonicalBlockHash ?? this.receipt?.blockHash ?? `0x${"00".repeat(32)}`;
    return quorum(
      { number: blockNumber, hash, parentHash: `0x${"0a".repeat(32)}` },
      this.canonicalBlockAgreed
    );
  }

  async blockNumber(): Promise<QuorumResult<number>> {
    return quorum(this.blockHeight, this.blockAgreed);
  }
}

export class FakeSigner implements TreasurySigner {
  calls: SignTransferRequest[] = [];
  failWith: Error | null = null;
  provenanceOverride: Partial<SignedTransactionProvenance> = {};
  delayMs = 0;

  async signTransfer(request: SignTransferRequest): Promise<SignedTransaction> {
    this.calls.push(request);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failWith) throw this.failWith;

    const callData = `0xa9059cbb${request.destination
      .slice(2)
      .padStart(
        64,
        "0"
      )}${BigInt(request.amountAtomic).toString(16).padStart(64, "0")}` as `0x${string}`;
    const rawTransaction =
      `0x${(BigInt(request.nonce) + 1n).toString(16).padStart(64, "0").slice(0, 64)}${"0".repeat(
        64
      )}` as `0x${string}`;

    const provenance: SignedTransactionProvenance = {
      chainId: request.chainId,
      to: request.tokenAddress,
      valueAtomic: "0",
      nonce: request.nonce,
      callData,
      destination: request.destination,
      amountAtomic: request.amountAtomic,
      ...this.provenanceOverride,
    };

    return {
      rawTransaction,
      hash: keccak256(rawTransaction),
      provenance,
    };
  }
}

export class FakeBroadcaster implements TreasuryBroadcaster {
  broadcasts: Array<`0x${string}`> = [];
  failCount = 0;
  overrideHash: `0x${string}` | null = null;
  onBroadcast: ((raw: `0x${string}`) => Promise<void> | void) | null = null;

  async broadcast(_asset: TreasuryAsset, rawTransaction: `0x${string}`): Promise<`0x${string}`> {
    this.broadcasts.push(rawTransaction);
    if (this.onBroadcast) await this.onBroadcast(rawTransaction);
    if (this.failCount > 0) {
      this.failCount -= 1;
      // Message intentionally resembles a credential-bearing RPC error.
      throw new Error("transport error at http://user:secret@rpc.example/key");
    }
    return this.overrideHash ?? keccak256(rawTransaction);
  }
}

export function matchingTransfer(amountAtomic = "500"): TransferLogObservation {
  return {
    tokenAddress: TOKEN,
    from: TREASURY,
    to: DESTINATION,
    amountAtomic,
    logIndex: 0,
    txHash: "0x" + "11".repeat(32),
  };
}

export function successReceipt(
  blockNumber: number,
  blockHash: string,
  transfers: TransferLogObservation[] = [matchingTransfer()]
): ReceiptObservation {
  return { status: "success", blockNumber, blockHash, transfers };
}

export function withStatus(asset: TreasuryAsset, status: AssetStatus): TreasuryAsset {
  return { ...asset, status };
}
