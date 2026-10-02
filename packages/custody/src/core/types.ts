/**
 * Core custody withdrawal contracts.
 *
 * These types are the narrow, Telegram-independent boundary between the
 * withdrawal workflow and its dependencies (durable store, signer, RPC quorum
 * reader, broadcaster, treasury accounting). They deliberately contain no
 * Telegram, no Fastify and no wire DTO duplication.
 *
 * Canonical wire contracts (asset identity, EIP-712 intent, incidents) live in
 * `@pokertools/types/canonical`; this module only models custody's persisted
 * rows and runtime ports.
 */
import type {
  AssetStatus,
  EvmAddress,
  IncidentSeverity,
  TxHash,
  WithdrawalStatus,
} from "@pokertools/types";
import type { IncidentKind } from "@pokertools/types";

// ============================================================================
// Lifecycle states
// ============================================================================

/**
 * Custody withdrawal lifecycle. Mirrors the canonical shared withdrawal
 * statuses exactly; the durable column is `WithdrawalIntentState`.
 */
export type WithdrawalState = WithdrawalStatus;

export const TERMINAL_WITHDRAWAL_STATES: readonly WithdrawalState[] = ["FINALIZED", "FAILED"];

/** States in which exact signed bytes already exist and must be observed. */
export const SIGNED_WITHDRAWAL_STATES: readonly WithdrawalState[] = [
  "SIGNED",
  "PERSISTED",
  "BROADCAST",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "FINALIZED",
  "AMBIGUOUS",
  "REORGED",
];

/** States the monitoring loop must keep advancing (even for frozen assets). */
export const MONITORING_WITHDRAWAL_STATES: readonly WithdrawalState[] = [
  "PERSISTED",
  "BROADCAST",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "FINALIZED",
  "AMBIGUOUS",
  "REORGED",
];

export const REPLACEMENT_POLICY = "NO_AUTOMATIC_REPLACEMENT" as const;

export function isTerminalWithdrawalState(state: WithdrawalState): boolean {
  return TERMINAL_WITHDRAWAL_STATES.includes(state);
}

export function isSignedWithdrawalState(state: WithdrawalState): boolean {
  return SIGNED_WITHDRAWAL_STATES.includes(state);
}

// ============================================================================
// Asset / route
// ============================================================================

/**
 * Canonical treasury asset metadata as persisted by the API.
 *
 * `assetId` is the canonical `eip155:<chainId>/erc20:<token>` identity and is
 * the primary key. `rpcUrls` is the validated multi-RPC registry, `minGasAtomic`
 * is the conservative native-gas floor (decimal string, wei) and `deepFinality`
 * is the reorg-safe finality depth.
 */
export interface TreasuryAsset {
  assetId: string;
  chainId: number;
  tokenAddress: EvmAddress;
  treasuryAddress: EvmAddress;
  rpcUrls: string[];
  minGasAtomic: string;
  confirmations: number;
  deepFinality: number;
  status: AssetStatus;
}

// ============================================================================
// Durable withdrawal record
// ============================================================================

export interface WithdrawalRecord {
  /** Canonical intent id; the durable primary key (`WithdrawalIntentRecord.id`). */
  intentId: string;
  principalId: string;
  assetId: string;
  chainId: number;
  destination: EvmAddress;
  /** Canonical decimal atomic amount. */
  amountAtomic: string;
  /** EIP-712 intent nonce (principal-scoped), safe integer. */
  nonce: number;
  /** Unix seconds; DB BigInt but safe integer on the wire. */
  deadline: number;
  /** EIP-712 signature accepted at reservation. */
  signature: string;
  payloadHash: string | null;
  state: WithdrawalState;
  /** Reserved pending-withdrawal journal id (finite hold). */
  reservedJournalId: string | null;
  /** Exact signed raw transaction bytes persisted before any broadcast. */
  signedRawTx: `0x${string}` | null;
  /** ERC-20 call data of the signed transaction. */
  signedCallData: `0x${string}` | null;
  /** Native value of the signed transaction (always "0" for ERC-20). */
  signedValueAtomic: string | null;
  /** Transaction hash of the exact persisted bytes. */
  txHash: TxHash | null;
  /** Treasury account nonce bound into the signed bytes (`broadcastNonce`). */
  treasuryNonce: number | null;
  /** Canonical receipt identity once observed by quorum. */
  receiptBlockNumber: string | null;
  receiptBlockHash: string | null;
  /** Journal id completed at confirmation (exactly-once accounting). */
  confirmedJournalId: string | null;
  /** Obligation journal id recorded on a post-completion reorg. */
  reorgJournalId: string | null;
  replacementPolicy: string;
  /** Route provenance captured at reservation (immutable after signing). */
  treasuryAddress: EvmAddress | null;
  tokenAddress: EvmAddress | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewWithdrawalRecord {
  intentId: string;
  principalId: string;
  assetId: string;
  chainId: number;
  destination: EvmAddress;
  amountAtomic: string;
  nonce: number;
  deadline: number;
  signature: string;
  payloadHash?: string | null;
  /** Journal id reserving the pending withdrawal hold, when supplied by finance. */
  reservedJournalId?: string | null;
  treasuryAddress?: EvmAddress | null;
  tokenAddress?: EvmAddress | null;
}

export interface TransitionPatch {
  signedRawTx?: `0x${string}`;
  signedCallData?: `0x${string}`;
  signedValueAtomic?: string;
  txHash?: TxHash;
  /** Maps to the durable `broadcastNonce` column. */
  treasuryNonce?: number;
  receiptBlockNumber?: string;
  receiptBlockHash?: string;
  reservedJournalId?: string;
  confirmedJournalId?: string;
  reorgJournalId?: string;
}

export interface TransitionRequest {
  intentId: string;
  from: WithdrawalState[];
  to: WithdrawalState;
  patch?: TransitionPatch;
  expectedTreasuryNonce?: number;
}

/**
 * Durable store for withdrawal obligations and the treasury nonce serializer.
 *
 * Implementations MUST make `withTreasuryLock` serialize per
 * `(chainId, treasuryAddress)` across processes using a pinned PostgreSQL
 * advisory-lock connection (or an equivalent durable row/CAS lock). The lock
 * covers nonce selection, signing and the persistence writes. `transition` MUST
 * be an optimistic compare-and-set so a stale worker cannot clobber a
 * concurrent decision.
 */
export interface WithdrawalStore {
  get(intentId: string): Promise<WithdrawalRecord | null>;
  create(record: NewWithdrawalRecord): Promise<WithdrawalRecord>;
  transition(request: TransitionRequest): Promise<WithdrawalRecord | null>;
  listByStates(states: WithdrawalState[], limit: number): Promise<WithdrawalRecord[]>;
  /**
   * Highest treasury nonce already persisted for the account, or -1 when none.
   * Used to derive the next nonce without reusing an already-signed nonce.
   */
  maxPersistedTreasuryNonce(chainId: number, treasuryAddress: string): Promise<number>;
  withTreasuryLock<T>(chainId: number, treasuryAddress: string, fn: () => Promise<T>): Promise<T>;
}

// ============================================================================
// Incidents
// ============================================================================

/** Incident kinds are the canonical generated enum (mandatory + operational). */
export type CustodyIncidentKind = IncidentKind;

export type IncidentStatus = "OPEN" | "INVESTIGATING" | "RESOLVED";

export interface IncidentRecord {
  incidentId: string;
  kind: CustodyIncidentKind;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assetId?: string;
  chainId?: number;
  principalId?: string;
  intentId?: string;
  detail: Record<string, unknown>;
  openedAt: number;
  resolvedAt?: number;
}

export interface OpenIncidentInput {
  kind: CustodyIncidentKind;
  severity: IncidentSeverity;
  assetId?: string;
  chainId?: number;
  principalId?: string;
  intentId?: string;
  detail?: Record<string, unknown>;
}

export interface IncidentResolution {
  resolvedBy: string;
  note: string;
  evidence?: Record<string, unknown>;
}

/**
 * Durable incident store. `open` is idempotent for an open
 * `(kind, affectedId, assetId)` triple so repeated worker ticks do not spam
 * incidents. Resolution is performed explicitly by an API operator service.
 */
export interface IncidentStore {
  open(input: OpenIncidentInput): Promise<IncidentRecord>;
  get(incidentId: string): Promise<IncidentRecord | null>;
  listOpen(filter?: { kind?: CustodyIncidentKind; assetId?: string }): Promise<IncidentRecord[]>;
  resolve(incidentId: string, resolution: IncidentResolution): Promise<IncidentRecord>;
}

// ============================================================================
// Asset registry
// ============================================================================

export interface AssetRegistry {
  get(assetId: string): Promise<TreasuryAsset | null>;
  list(): Promise<TreasuryAsset[]>;
  setStatus(assetId: string, status: AssetStatus, reason: string): Promise<void>;
}

// ============================================================================
// Treasury accounting (finance-core port)
// ============================================================================

export interface ReconciliationEvidence {
  assetId: string;
  chainId: number;
  treasuryAddress: string;
  /** Quorum-agreed on-chain ERC-20 custody balance. */
  custodyAtomic: string;
  /** Accounting-expected atomic balance across account classes (signed net,
   * excluding the TREASURY_RESERVE external counterparty). */
  expectedAtomic: string;
  /** Per-RPC observations backing the custody balance. */
  observations: Array<{ rpcUrl: string; valueAtomic: string }>;
  observedAt: number;
  mismatch: boolean;
}

/**
 * Port implemented by the API finance-core export. Custody calls this only at
 * the defined accounting boundaries: confirmation (pending withdrawal ->
 * treasury reserve), reorg obligation, and reconciliation evidence.
 */
export interface TreasuryAccounting {
  /**
   * Complete a withdrawal at confirmation: PENDING_WITHDRAWAL `-a`,
   * TREASURY_RESERVE `+a`. Must be idempotent; custody also persists the
   * returned journal id as `confirmedJournalId` to enforce exactly-once.
   */
  completeWithdrawal(record: WithdrawalRecord): Promise<{ journalId: string }>;
  /**
   * Post-completion reorg obligation: INCIDENT_OBLIGATION `+a`,
   * TREASURY_RESERVE `-a`. Must be idempotent; custody persists the returned
   * journal id as `reorgJournalId`.
   */
  recordObligation(
    record: WithdrawalRecord,
    incident: IncidentRecord
  ): Promise<{ journalId: string }>;
  /** Persist reconciliation evidence. */
  recordReconciliation(evidence: ReconciliationEvidence): Promise<{ journalId: string }>;
  /**
   * Accounting-expected atomic balance for an asset: the signed net of all
   * account classes excluding the TREASURY_RESERVE counterparty.
   */
  expectedTreasuryAtomic(assetId: string): Promise<string>;
}

// ============================================================================
// Signer
// ============================================================================

export interface SignTransferRequest {
  chainId: number;
  rpcUrls: string[];
  tokenAddress: EvmAddress;
  treasuryAddress: EvmAddress;
  destination: EvmAddress;
  amountAtomic: string;
  nonce: number;
}

/**
 * Provenance parsed from the signed bytes. The workflow validates it against the
 * reserved intent before persisting/broadcasting, so a trusted signer adapter
 * cannot silently sign a different destination/amount/nonce.
 */
export interface SignedTransactionProvenance {
  chainId: number;
  to: EvmAddress;
  valueAtomic: string;
  nonce: number;
  callData: `0x${string}`;
  /** Decoded ERC-20 transfer destination. */
  destination: EvmAddress;
  /** Decoded ERC-20 transfer amount. */
  amountAtomic: string;
}

export interface SignedTransaction {
  rawTransaction: `0x${string}`;
  hash: TxHash;
  provenance: SignedTransactionProvenance;
}

/**
 * Signing port. Custody owns the only implementation; the API never loads
 * signer secrets. Signing must be deterministic for identical inputs so that
 * recovery can reproduce the exact bytes.
 */
export interface TreasurySigner {
  signTransfer(request: SignTransferRequest): Promise<SignedTransaction>;
}

// ============================================================================
// Broadcast
// ============================================================================

/**
 * Stable, non-sensitive broadcast failure codes. Raw transport messages may
 * embed credential-bearing RPC URLs and must never be persisted or logged.
 */
export type BroadcastFailureCode =
  "BROADCAST_TRANSPORT_ERROR" | "BROADCAST_REJECTED" | "BROADCAST_UNKNOWN";

export interface BroadcastError {
  code: BroadcastFailureCode;
}

export interface TreasuryBroadcaster {
  /** Broadcast exact raw bytes; must return the hash of those bytes. */
  broadcast(asset: TreasuryAsset, rawTransaction: `0x${string}`): Promise<TxHash>;
}

// ============================================================================
// RPC quorum reader
// ============================================================================

export interface RpcObservation<T> {
  rpcUrl: string;
  value: T;
}

export interface QuorumResult<T> {
  /** True only when the configured threshold agreed on a single value. */
  agreed: boolean;
  /** Agreed value, or null when quorum was not reached. */
  value: T | null;
  observations: Array<RpcObservation<T>>;
  errors: Array<{ rpcUrl: string; message: string }>;
}

export interface TransferLogObservation {
  tokenAddress: EvmAddress;
  from: EvmAddress;
  to: EvmAddress;
  amountAtomic: string;
  logIndex: number;
  txHash: TxHash;
}

export interface ReceiptObservation {
  status: "success" | "reverted";
  blockNumber: number;
  blockHash: string;
  /** Decoded ERC-20 Transfer logs from the receipt. */
  transfers: TransferLogObservation[];
}

export interface BlockObservation {
  number: number;
  hash: string;
  parentHash: string;
}

export type BlockTag = "latest" | "pending";

export interface RpcQuorumReader {
  nativeBalance(asset: TreasuryAsset, address: EvmAddress): Promise<QuorumResult<bigint>>;
  erc20BalanceOf(asset: TreasuryAsset, owner: EvmAddress): Promise<QuorumResult<bigint>>;
  transactionCount(
    asset: TreasuryAsset,
    address: EvmAddress,
    blockTag: BlockTag
  ): Promise<QuorumResult<number>>;
  transactionReceipt(
    asset: TreasuryAsset,
    hash: TxHash
  ): Promise<QuorumResult<ReceiptObservation | null>>;
  /**
   * Canonical block at `blockNumber`. The workflow compares its hash with the
   * receipt's `blockHash` before any confirmation/finality decision, so a
   * receipt whose block is no longer canonical (including a missing receipt)
   * is never credited.
   */
  block(asset: TreasuryAsset, blockNumber: number): Promise<QuorumResult<BlockObservation>>;
  blockNumber(asset: TreasuryAsset): Promise<QuorumResult<number>>;
}

// ============================================================================
// Misc ports
// ============================================================================

export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export interface CustodyLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}
