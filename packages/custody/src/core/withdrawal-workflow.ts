/**
 * Narrow custody withdrawal workflow.
 *
 * Invariants enforced here (Telegram-independent, callable/testable in
 * isolation):
 *
 * 1. Persist-before-broadcast: treasury nonce (`broadcastNonce`), route
 *    provenance, ERC-20 call data, exact signed raw bytes and their hash are
 *    durably persisted before any broadcast call.
 * 2. Serialized treasury nonces: nonce selection, signing and persistence run
 *    under a pinned per `(chainId, treasuryAddress)` durable lock. The nonce
 *    requires RPC quorum; when quorum is unavailable signing fails closed
 *    rather than guessing.
 * 3. No automatic replacement: once bytes exist they are never re-signed or
 *    refunded. Ambiguous broadcasts retain the obligation and exact bytes;
 *    recovery re-broadcasts the same bytes after observation.
 * 4. Conservative native-gas quorum gate: insufficient native balance yields
 *    `BLOCKED_GAS` plus a `GAS_STARVATION` incident, never a refund.
 * 5. Frozen/degraded routes stop new signing; signed obligations keep being
 *    monitored.
 * 6. Confirmation requires quorum agreement on a canonical receipt containing
 *    the expected ERC-20 Transfer (token, destination, amount). Accounting
 *    completion (pending withdrawal -> treasury reserve) happens only on
 *    confirmation and exactly once (`confirmedJournalId`).
 * 7. Reorgs preserve history as a `WITHDRAWAL_REORG` incident. After
 *    completion, an `INCIDENT_OBLIGATION` journal restores the obligation
 *    exactly once (`reorgJournalId`); pre-completion reorgs keep the existing
 *    PENDING_WITHDRAWAL obligation with no second liability. The route freezes
 *    but monitoring continues.
 * 8. Reconciliation compares quorum ERC-20 custody against accounting-expected
 *    signed net liabilities; a mismatch freezes and raises
 *    `TREASURY_SHORTFALL`.
 */
import type { AssetStatus, EvmAddress, TxHash } from "@pokertools/types";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import type {
  AssetRegistry,
  Clock,
  CustodyIncidentKind,
  CustodyLogger,
  IncidentRecord,
  IncidentStore,
  NewWithdrawalRecord,
  QuorumResult,
  RpcQuorumReader,
  SignedTransaction,
  TreasuryAccounting,
  TreasuryAsset,
  TreasuryBroadcaster,
  TreasurySigner,
  WithdrawalRecord,
  WithdrawalState,
  WithdrawalStore,
  ReconciliationEvidence,
  BroadcastFailureCode,
} from "./types.js";
import {
  MONITORING_WITHDRAWAL_STATES,
  isSignedWithdrawalState,
  isTerminalWithdrawalState,
} from "./types.js";

export interface WithdrawalWorkflowConfig {
  /** Minimum agreeing RPC observations for a quorum decision. */
  minQuorum: number;
  /** Max records to scan per state bucket per tick. */
  maxScanBatch: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WithdrawalWorkflowConfig = {
  minQuorum: 2,
  maxScanBatch: 25,
};

const MAX_SAFE_NONCE = Number.MAX_SAFE_INTEGER;

export type ProcessAction =
  | "none"
  | "skipped_frozen"
  | "expired"
  | "blocked_gas"
  | "blocked_quorum"
  | "signed_broadcast"
  | "rebroadcast"
  | "ambiguous"
  | "pending_confirmation"
  | "confirmed"
  | "finalized"
  | "reorged"
  | "failed"
  | "blocked_reverted"
  | "malformed";

export interface ProcessOutcome {
  intentId: string;
  action: ProcessAction;
  state: WithdrawalState | null;
  txHash: TxHash | null;
}

export interface RunSummary {
  signed: number;
  broadcast: number;
  monitored: number;
  confirmed: number;
  finalized: number;
  reorged: number;
  blocked: number;
  failed: number;
}

export interface ReconciliationOutcome {
  assetId: string;
  mismatch: boolean;
  custodyAtomic: string;
  expectedAtomic: string;
  incident: IncidentRecord | null;
}

export interface WithdrawalWorkflowDeps {
  store: WithdrawalStore;
  incidents: IncidentStore;
  assets: AssetRegistry;
  accounting: TreasuryAccounting;
  signer: TreasurySigner;
  quorum: RpcQuorumReader;
  broadcaster: TreasuryBroadcaster;
  clock: Clock;
  logger: CustodyLogger;
  config?: Partial<WithdrawalWorkflowConfig>;
}

export class WithdrawalWorkflow {
  private readonly store: WithdrawalStore;
  private readonly incidents: IncidentStore;
  private readonly assets: AssetRegistry;
  private readonly accounting: TreasuryAccounting;
  private readonly signer: TreasurySigner;
  private readonly quorum: RpcQuorumReader;
  private readonly broadcaster: TreasuryBroadcaster;
  private readonly clock: Clock;
  private readonly logger: CustodyLogger;
  private readonly config: WithdrawalWorkflowConfig;

  constructor(deps: WithdrawalWorkflowDeps) {
    this.store = deps.store;
    this.incidents = deps.incidents;
    this.assets = deps.assets;
    this.accounting = deps.accounting;
    this.signer = deps.signer;
    this.quorum = deps.quorum;
    this.broadcaster = deps.broadcaster;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.config = { ...DEFAULT_WORKFLOW_CONFIG, ...(deps.config ?? {}) };
  }

  /**
   * Accept an already-verified EIP-712 withdrawal intent. The caller (API
   * finance-core) owns signature verification and funds reservation; custody
   * only records the obligation.
   */
  async acceptIntent(record: NewWithdrawalRecord): Promise<WithdrawalRecord> {
    return this.store.create(record);
  }

  async processIntent(intentId: string): Promise<ProcessOutcome> {
    const record = await this.store.get(intentId);
    if (!record) return { intentId, action: "none", state: null, txHash: null };

    if (isTerminalWithdrawalState(record.state)) {
      return { intentId, action: "none", state: record.state, txHash: record.txHash };
    }

    if (record.state === "RESERVED" || record.state === "BLOCKED_GAS") {
      return this.handleSignable(record);
    }

    return this.monitorRecord(record);
  }

  /** Advance pending obligations. Scope: signable first, then monitoring. */
  async runOnce(): Promise<RunSummary> {
    const summary: RunSummary = {
      signed: 0,
      broadcast: 0,
      monitored: 0,
      confirmed: 0,
      finalized: 0,
      reorged: 0,
      blocked: 0,
      failed: 0,
    };

    const signable = await this.store.listByStates(
      ["RESERVED", "BLOCKED_GAS"],
      this.config.maxScanBatch
    );
    for (const record of signable) {
      this.tally(summary, await this.processIntent(record.intentId));
    }

    const monitoring = await this.store.listByStates(
      [...MONITORING_WITHDRAWAL_STATES],
      this.config.maxScanBatch
    );
    for (const record of monitoring) {
      this.tally(summary, await this.monitorRecord(record));
    }

    return summary;
  }

  private tally(summary: RunSummary, outcome: ProcessOutcome): void {
    switch (outcome.action) {
      case "signed_broadcast":
        summary.signed += 1;
        summary.broadcast += 1;
        break;
      case "rebroadcast":
        summary.broadcast += 1;
        break;
      case "confirmed":
        summary.confirmed += 1;
        break;
      case "finalized":
        summary.finalized += 1;
        break;
      case "reorged":
        summary.reorged += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "blocked_gas":
      case "blocked_quorum":
      case "blocked_reverted":
      case "skipped_frozen":
        summary.blocked += 1;
        break;
      default:
        summary.monitored += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Signable: RESERVED / BLOCKED_GAS
  // -------------------------------------------------------------------------

  private async handleSignable(record: WithdrawalRecord): Promise<ProcessOutcome> {
    const asset = await this.assets.get(record.assetId);
    if (!asset) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "asset_unknown",
      });
      return { intentId: record.intentId, action: "malformed", state: record.state, txHash: null };
    }

    // Only an ACTIVE route may create new risk. Frozen/degraded obligations
    // are still monitored by monitorRecord.
    if (asset.status !== "ACTIVE") {
      return {
        intentId: record.intentId,
        action: "skipped_frozen",
        state: record.state,
        txHash: null,
      };
    }

    const nowSeconds = Math.floor(this.clock.now() / 1000);
    if (nowSeconds > record.deadline) {
      // Never drop a reserved obligation. The pending-withdrawal hold stays in
      // place and an operator must resolve it explicitly; there is no blind
      // refund and no terminal state that erases the debt.
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "intent_expired_operator_resolution",
        deadline: record.deadline,
      });
      return { intentId: record.intentId, action: "expired", state: record.state, txHash: null };
    }

    // Conservative native-gas quorum gate. Obligation is retained (never
    // refunded) while gas is insufficient.
    const gasDecision = await this.checkNativeGas(asset, record);
    if (!gasDecision.ok) {
      return {
        intentId: record.intentId,
        action: gasDecision.action,
        state: gasDecision.state,
        txHash: null,
      };
    }

    // Gas is available: leave BLOCKED_GAS for the signing lane.
    if (record.state === "BLOCKED_GAS") {
      const advanced = await this.store.transition({
        intentId: record.intentId,
        from: ["BLOCKED_GAS"],
        to: "RESERVED",
      });
      if (!advanced)
        return { intentId: record.intentId, action: "none", state: null, txHash: null };
      record = advanced;
    }

    const persisted = await this.signUnderLock(record, asset);
    if (!persisted) {
      return { intentId: record.intentId, action: "none", state: record.state, txHash: null };
    }

    const broadcast = await this.broadcastExactBytes(persisted, asset);
    return {
      intentId: persisted.intentId,
      action: broadcast.action,
      state: broadcast.state,
      txHash: persisted.txHash,
    };
  }

  private async checkNativeGas(
    asset: TreasuryAsset,
    record: WithdrawalRecord
  ): Promise<
    { ok: true } | { ok: false; action: "blocked_gas" | "blocked_quorum"; state: WithdrawalState }
  > {
    const balance = await this.quorum.nativeBalance(asset, asset.treasuryAddress);
    if (!this.quorumAgreed(balance)) {
      await this.blockForGas(record, "RPC_DISAGREEMENT", {
        reason: "native_balance_quorum_unavailable",
        observationCount: balance.observations.length,
        errorCount: balance.errors.length,
      });
      return { ok: false, action: "blocked_quorum", state: "BLOCKED_GAS" };
    }

    const available = balance.value ?? 0n;
    const floor = BigInt(asset.minGasAtomic);
    if (floor <= 0n) {
      // A non-positive configured floor cannot gate signing; fail closed until
      // an operator sets a real conservative minimum.
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "invalid_gas_floor",
        minGasAtomic: asset.minGasAtomic,
      });
      return { ok: false, action: "blocked_quorum", state: "BLOCKED_GAS" };
    }
    if (available < floor) {
      await this.blockForGas(record, "GAS_STARVATION", {
        availableAtomic: available.toString(),
        minGasAtomic: asset.minGasAtomic,
      });
      return { ok: false, action: "blocked_gas", state: "BLOCKED_GAS" };
    }

    return { ok: true };
  }

  private async blockForGas(
    record: WithdrawalRecord,
    kind: CustodyIncidentKind,
    detail: Record<string, unknown>
  ): Promise<void> {
    if (record.state === "RESERVED") {
      await this.store.transition({
        intentId: record.intentId,
        from: ["RESERVED"],
        to: "BLOCKED_GAS",
      });
    }
    await this.openIncident(kind, "CRITICAL", record, detail);
  }

  private async signUnderLock(
    record: WithdrawalRecord,
    asset: TreasuryAsset
  ): Promise<WithdrawalRecord | null> {
    return this.store.withTreasuryLock(asset.chainId, asset.treasuryAddress, async () => {
      // Re-read under the durable lock: another worker may have advanced it.
      const fresh = await this.store.get(record.intentId);
      if (!fresh) return null;
      if (fresh.state !== "RESERVED") return null;
      if (fresh.signedRawTx !== null || fresh.txHash !== null) return fresh;

      const freshAsset = await this.assets.get(fresh.assetId);
      // Route must be ACTIVE, not merely not-frozen.
      if (!freshAsset) {
        await this.openIncident("CUSTODY_FAILURE", "WARNING", fresh, {
          reason: "route_not_active_under_lock",
          status: "UNKNOWN",
        });
        return null;
      }
      if (freshAsset.status !== "ACTIVE") {
        await this.openIncident("CUSTODY_FAILURE", "WARNING", fresh, {
          reason: "route_not_active_under_lock",
          status: freshAsset.status,
        });
        return null;
      }

      // Re-check deadline immediately before signing. An expired intent keeps
      // its reservation and requires explicit operator resolution.
      const nowSeconds = Math.floor(this.clock.now() / 1000);
      if (nowSeconds > fresh.deadline) {
        await this.openIncident("CUSTODY_FAILURE", "CRITICAL", fresh, {
          reason: "intent_expired_under_lock_operator_resolution",
          deadline: fresh.deadline,
        });
        return null;
      }

      // Re-check gas quorum immediately before signing.
      if (
        fresh.chainId !== freshAsset.chainId ||
        fresh.treasuryAddress?.toLowerCase() !== freshAsset.treasuryAddress.toLowerCase() ||
        fresh.tokenAddress?.toLowerCase() !== freshAsset.tokenAddress.toLowerCase()
      ) {
        await this.openIncident("CUSTODY_FAILURE", "CRITICAL", fresh, {
          reason: "reserved_route_changed",
        });
        return null;
      }
      const gas = await this.quorum.nativeBalance(freshAsset, freshAsset.treasuryAddress);
      if (!this.quorumAgreed(gas)) {
        await this.openIncident("RPC_DISAGREEMENT", "CRITICAL", fresh, {
          reason: "native_gas_quorum_under_lock",
        });
        return null;
      }
      if ((gas.value ?? 0n) < BigInt(freshAsset.minGasAtomic)) {
        await this.openIncident("GAS_STARVATION", "CRITICAL", fresh, {
          availableAtomic: (gas.value ?? 0n).toString(),
          minGasAtomic: freshAsset.minGasAtomic,
        });
        return null;
      }

      const nonce = await this.deriveTreasuryNonce(freshAsset, fresh);
      if (nonce === null) {
        await this.openIncident("RPC_DISAGREEMENT", "CRITICAL", fresh, {
          reason: "nonce_quorum_unavailable",
        });
        return null;
      }

      let signed: SignedTransaction;
      try {
        signed = await this.signer.signTransfer({
          chainId: freshAsset.chainId,
          rpcUrls: freshAsset.rpcUrls,
          tokenAddress: freshAsset.tokenAddress,
          treasuryAddress: freshAsset.treasuryAddress,
          destination: fresh.destination,
          amountAtomic: fresh.amountAtomic,
          nonce,
        });
      } catch (error) {
        // Never propagate raw transport/RPC errors: they may embed credential
        // URLs. Persist a stable error name only; the obligation is retained.
        await this.openIncident("CUSTODY_FAILURE", "CRITICAL", fresh, {
          reason: "signing_failed",
          code: error instanceof Error ? error.name : "UNKNOWN",
        });
        return null;
      }

      // Validate the signed provenance against the reserved intent before any
      // bytes are committed.
      const provenance = signed.provenance;
      const expectedCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [fresh.destination as `0x${string}`, BigInt(fresh.amountAtomic)],
      });
      let bytesMatch = false;
      try {
        const transaction = parseTransaction(signed.rawTransaction);
        const sender = await recoverTransactionAddress({
          serializedTransaction: signed.rawTransaction as TransactionSerialized,
        });
        bytesMatch =
          keccak256(signed.rawTransaction) === signed.hash &&
          transaction.chainId === freshAsset.chainId &&
          transaction.to?.toLowerCase() === freshAsset.tokenAddress.toLowerCase() &&
          (transaction.value ?? 0n) === 0n &&
          transaction.nonce === nonce &&
          transaction.data === expectedCallData &&
          sender.toLowerCase() === freshAsset.treasuryAddress.toLowerCase();
      } catch {
        // Malformed or unsigned bytes are never persisted or broadcast.
      }
      const provenanceOk =
        bytesMatch &&
        provenance.chainId === freshAsset.chainId &&
        provenance.to.toLowerCase() === freshAsset.tokenAddress.toLowerCase() &&
        provenance.valueAtomic === "0" &&
        provenance.nonce === nonce &&
        provenance.destination.toLowerCase() === fresh.destination.toLowerCase() &&
        provenance.amountAtomic === fresh.amountAtomic &&
        provenance.callData === expectedCallData;
      if (!provenanceOk) {
        await this.openIncident("CUSTODY_FAILURE", "CRITICAL", fresh, {
          reason: "signed_provenance_mismatch",
          expected: {
            chainId: freshAsset.chainId,
            tokenAddress: freshAsset.tokenAddress,
            destination: fresh.destination,
            amountAtomic: fresh.amountAtomic,
            nonce,
            valueAtomic: "0",
          },
          observed: provenance,
        });
        return null;
      }

      return this.store.transition({
        intentId: fresh.intentId,
        from: ["RESERVED"],
        to: "PERSISTED",
        patch: {
          signedRawTx: signed.rawTransaction,
          signedCallData: provenance.callData,
          signedValueAtomic: provenance.valueAtomic,
          txHash: signed.hash,
          treasuryNonce: nonce,
        },
      });
    });
  }

  /**
   * Next treasury nonce. Requires on-chain `pending` nonce quorum; the durable
   * lock plus `maxPersistedTreasuryNonce` prevents reuse. There is deliberately
   * no "guess from local state" fallback: when quorum is unavailable signing
   * fails closed.
   */
  private async deriveTreasuryNonce(
    asset: TreasuryAsset,
    record: WithdrawalRecord
  ): Promise<number | null> {
    const count = await this.quorum.transactionCount(asset, asset.treasuryAddress, "pending");
    if (!this.quorumAgreed(count) || count.value === null) {
      this.logger.warn(
        { intentId: record.intentId, chainId: asset.chainId },
        "treasury nonce quorum unavailable; refusing to sign"
      );
      return null;
    }
    const persistedMax = await this.store.maxPersistedTreasuryNonce(
      asset.chainId,
      asset.treasuryAddress
    );
    const onChain = BigInt(count.value);
    const persistedNext = BigInt(persistedMax + 1);
    const candidate = onChain > persistedNext ? onChain : persistedNext;
    if (candidate < 0n || candidate > BigInt(MAX_SAFE_NONCE)) {
      throw new RangeError("Treasury nonce exceeds safe integer range");
    }
    return Number(candidate);
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  private async broadcastExactBytes(
    record: WithdrawalRecord,
    asset: TreasuryAsset
  ): Promise<{ action: "signed_broadcast" | "ambiguous" | "malformed"; state: WithdrawalState }> {
    if (!record.signedRawTx || !record.txHash || record.treasuryNonce === null) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "missing_persisted_bytes",
      });
      return { action: "malformed", state: record.state };
    }

    try {
      const hash = await this.broadcaster.broadcast(asset, record.signedRawTx);
      if (hash.toLowerCase() !== record.txHash.toLowerCase()) {
        await this.openIncident("NONCE_CONFLICT", "CRITICAL", record, {
          expectedHash: record.txHash,
          observedHash: hash,
        });
        return { action: "malformed", state: record.state };
      }
      const advanced = await this.store.transition({
        intentId: record.intentId,
        from: ["PERSISTED"],
        to: "BROADCAST",
        expectedTreasuryNonce: record.treasuryNonce,
      });
      return { action: "signed_broadcast", state: advanced?.state ?? "PERSISTED" };
    } catch (error) {
      // Ambiguous outcome: the node may or may not have accepted the transaction.
      // Retain the obligation and exact bytes; never refund or re-sign. Only a
      // stable code is persisted because raw transport errors may embed
      // credential-bearing RPC URLs.
      const code = classifyBroadcastFailure(error);
      await this.store.transition({
        intentId: record.intentId,
        from: ["PERSISTED"],
        to: "AMBIGUOUS",
        expectedTreasuryNonce: record.treasuryNonce,
      });
      await this.openIncident("AMBIGUOUS_CUSTODY_STATE", "CRITICAL", record, {
        reason: "broadcast_error",
        code,
      });
      return { action: "ambiguous", state: "AMBIGUOUS" };
    }
  }

  // -------------------------------------------------------------------------
  // Monitoring: PERSISTED / BROADCAST / PENDING_CONFIRMATION / CONFIRMED /
  // FINALIZED / AMBIGUOUS / REORGED
  // -------------------------------------------------------------------------

  private async monitorRecord(record: WithdrawalRecord): Promise<ProcessOutcome> {
    if (!record.txHash) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "monitoring_without_hash",
      });
      return { intentId: record.intentId, action: "malformed", state: record.state, txHash: null };
    }

    const asset = await this.assets.get(record.assetId);
    if (!asset) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "asset_unknown",
      });
      return {
        intentId: record.intentId,
        action: "malformed",
        state: record.state,
        txHash: record.txHash,
      };
    }

    // Monitoring intentionally ignores route freeze: signed obligations must
    // continue to be observed.
    const receiptResult = await this.quorum.transactionReceipt(asset, record.txHash);
    if (!this.quorumAgreed(receiptResult)) {
      await this.openIncident("RPC_DISAGREEMENT", "CRITICAL", record, {
        reason: "receipt_quorum",
        observationCount: receiptResult.observations.length,
        errorCount: receiptResult.errors.length,
      });
      return {
        intentId: record.intentId,
        action: "blocked_quorum",
        state: record.state,
        txHash: record.txHash,
      };
    }

    const receipt = receiptResult.value;
    if (!receipt) {
      return this.monitorWithoutReceipt(record, asset);
    }

    // Canonical block identity: the receipt's block hash must equal the block
    // quorum's hash at that height before any credit/finality decision. A
    // non-agreed block read is an RPC outage (fail closed, never a reorg); a
    // canonical mismatch on an already-recorded receipt is a reorg.
    const blockResult = await this.quorum.block(asset, receipt.blockNumber);
    if (!this.quorumAgreed(blockResult) || blockResult.value === null) {
      await this.openIncident("RPC_DISAGREEMENT", "CRITICAL", record, {
        reason: "canonical_block_quorum",
        blockNumber: receipt.blockNumber,
      });
      return {
        intentId: record.intentId,
        action: "blocked_quorum",
        state: record.state,
        txHash: record.txHash,
      };
    }
    if (blockResult.value.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      if (isConfirmationStage(record.state) && record.receiptBlockHash !== null) {
        return this.handleReorg(record, asset, "canonical_block_mismatch");
      }
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "receipt_block_not_canonical",
        blockNumber: receipt.blockNumber,
        receiptBlockHash: receipt.blockHash,
        canonicalBlockHash: blockResult.value.hash,
      });
      await this.assets.setStatus(asset.assetId, "FROZEN", "receipt block not canonical");
      return {
        intentId: record.intentId,
        action: "blocked_quorum",
        state: record.state,
        txHash: record.txHash,
      };
    }

    // A receipt that disappeared after having been observed (or moved to a
    // different block) is a reorg for confirmation-stage records.
    if (
      isConfirmationStage(record.state) &&
      record.receiptBlockHash !== null &&
      (receipt.blockHash !== record.receiptBlockHash ||
        receipt.blockNumber.toString() !== record.receiptBlockNumber)
    ) {
      return this.handleReorg(record, asset, "receipt_moved");
    }

    if (receipt.status === "reverted") {
      // A mined-but-reverted payout leaves the signed obligation and the
      // pending-withdrawal hold intact. Never transition to a terminal state
      // that erases the debt; freeze and require operator resolution.
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "transaction_reverted_operator_resolution",
        blockNumber: receipt.blockNumber,
      });
      await this.assets.setStatus(asset.assetId, "FROZEN", "withdrawal transaction reverted");
      return {
        intentId: record.intentId,
        action: "blocked_reverted",
        state: record.state,
        txHash: record.txHash,
      };
    }

    // Require the canonical expected Transfer in the quorum receipt.
    const transferOk = receipt.transfers.some(
      (transfer) =>
        transfer.tokenAddress.toLowerCase() === asset.tokenAddress.toLowerCase() &&
        transfer.to.toLowerCase() === record.destination.toLowerCase() &&
        transfer.amountAtomic === record.amountAtomic
    );
    if (!transferOk) {
      // Do not confirm: preserve obligation and freeze for operator review.
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "transfer_mismatch",
        expected: {
          token: asset.tokenAddress,
          destination: record.destination,
          amountAtomic: record.amountAtomic,
        },
      });
      await this.assets.setStatus(asset.assetId, "FROZEN", "withdrawal transfer mismatch");
      return {
        intentId: record.intentId,
        action: "blocked_quorum",
        state: record.state,
        txHash: record.txHash,
      };
    }

    // Record/refresh canonical receipt provenance.
    if (!isConfirmationStage(record.state) || record.receiptBlockHash === null) {
      const advanced = await this.store.transition({
        intentId: record.intentId,
        from: [record.state],
        to: "PENDING_CONFIRMATION",
        patch: {
          receiptBlockNumber: receipt.blockNumber.toString(),
          receiptBlockHash: receipt.blockHash,
        },
      });
      if (advanced) {
        return {
          intentId: record.intentId,
          action: "pending_confirmation",
          state: advanced.state,
          txHash: record.txHash,
        };
      }
      record = (await this.store.get(record.intentId)) ?? record;
    }

    const latest = await this.quorum.blockNumber(asset);
    if (!this.quorumAgreed(latest) || latest.value === null) {
      await this.openIncident("RPC_DISAGREEMENT", "CRITICAL", record, {
        reason: "block_number_quorum",
      });
      return {
        intentId: record.intentId,
        action: "blocked_quorum",
        state: record.state,
        txHash: record.txHash,
      };
    }

    const confirmations = Math.max(0, latest.value - receipt.blockNumber + 1);

    // Accounting completion must precede finality. If a previous tick completed
    // the state transition but not the journal, retry here (idempotent).
    if (
      record.state === "CONFIRMED" &&
      record.confirmedJournalId === null &&
      confirmations >= asset.confirmations
    ) {
      const completed = await this.completeAccounting(record);
      if (completed) record = completed;
    }

    if (
      confirmations >= asset.deepFinality &&
      record.state === "CONFIRMED" &&
      record.confirmedJournalId !== null
    ) {
      const finalized = await this.store.transition({
        intentId: record.intentId,
        from: ["CONFIRMED"],
        to: "FINALIZED",
      });
      return {
        intentId: record.intentId,
        action: finalized ? "finalized" : "none",
        state: finalized?.state ?? null,
        txHash: record.txHash,
      };
    }

    if (confirmations >= asset.confirmations && record.state === "PENDING_CONFIRMATION") {
      const advanced = await this.store.transition({
        intentId: record.intentId,
        from: ["PENDING_CONFIRMATION"],
        to: "CONFIRMED",
        patch: {
          receiptBlockNumber: receipt.blockNumber.toString(),
          receiptBlockHash: receipt.blockHash,
        },
      });
      if (!advanced) {
        return { intentId: record.intentId, action: "none", state: null, txHash: record.txHash };
      }
      await this.completeAccounting(advanced);
      return {
        intentId: record.intentId,
        action: "confirmed",
        state: "CONFIRMED",
        txHash: record.txHash,
      };
    }

    return {
      intentId: record.intentId,
      action: "none",
      state: record.state,
      txHash: record.txHash,
    };
  }

  /**
   * Complete the withdrawal exactly once: PENDING_WITHDRAWAL -> TREASURY_RESERVE
   * at confirmation. The journal id is persisted as `confirmedJournalId`, so a
   * crash between the transition and the journal is retried safely. The
   * accounting adapter never touches the lifecycle `state`.
   */
  private async completeAccounting(record: WithdrawalRecord): Promise<WithdrawalRecord | null> {
    if (record.confirmedJournalId !== null) return record;
    try {
      const { journalId } = await this.accounting.completeWithdrawal(record);
      return this.store.transition({
        intentId: record.intentId,
        from: ["CONFIRMED"],
        to: "CONFIRMED",
        patch: { confirmedJournalId: journalId },
      });
    } catch {
      this.logger.error(
        { intentId: record.intentId, code: "ACCOUNTING_COMPLETION_FAILED" },
        "treasury accounting completion failed"
      );
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "accounting_completion_failed",
      });
      return null;
    }
  }

  private async monitorWithoutReceipt(
    record: WithdrawalRecord,
    asset: TreasuryAsset
  ): Promise<ProcessOutcome> {
    if (!record.signedRawTx) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "no_bytes_to_rebroadcast",
      });
      return {
        intentId: record.intentId,
        action: "malformed",
        state: record.state,
        txHash: record.txHash,
      };
    }

    // A record that reached confirmation stage but whose receipt vanished is a
    // reorg; preserve history and freeze.
    if (isConfirmationStage(record.state) && record.receiptBlockHash !== null) {
      return this.handleReorg(record, asset, "receipt_missing");
    }

    // Observation failed to find the transaction: re-broadcast the exact same
    // bytes. Never sign a replacement and never refund.
    try {
      const hash = await this.broadcaster.broadcast(asset, record.signedRawTx);
      if (record.txHash && hash.toLowerCase() !== record.txHash.toLowerCase()) {
        await this.openIncident("NONCE_CONFLICT", "CRITICAL", record, {
          expectedHash: record.txHash,
          observedHash: hash,
        });
        return {
          intentId: record.intentId,
          action: "malformed",
          state: record.state,
          txHash: record.txHash,
        };
      }
      if (record.state === "PERSISTED" || record.state === "AMBIGUOUS") {
        await this.store.transition({
          intentId: record.intentId,
          from: [record.state],
          to: "BROADCAST",
        });
      }
      return {
        intentId: record.intentId,
        action: "rebroadcast",
        state: "BROADCAST",
        txHash: record.txHash,
      };
    } catch (error) {
      const code = classifyBroadcastFailure(error);
      await this.store.transition({
        intentId: record.intentId,
        from: [record.state],
        to: "AMBIGUOUS",
      });
      await this.openIncident("AMBIGUOUS_CUSTODY_STATE", "CRITICAL", record, {
        reason: "rebroadcast_error",
        code,
      });
      return {
        intentId: record.intentId,
        action: "ambiguous",
        state: "AMBIGUOUS",
        txHash: record.txHash,
      };
    }
  }

  private async handleReorg(
    record: WithdrawalRecord,
    asset: TreasuryAsset,
    reason: string
  ): Promise<ProcessOutcome> {
    const completionRecorded = record.state === "CONFIRMED" || record.state === "FINALIZED";

    const incident = await this.openIncident("WITHDRAWAL_REORG", "CRITICAL", record, {
      reason,
      priorBlockNumber: record.receiptBlockNumber,
      priorBlockHash: record.receiptBlockHash,
      completionRecorded,
    });

    // Ledger contract: an after-completion reorg restores the economic
    // obligation exactly once via INCIDENT_OBLIGATION +a / TREASURY_RESERVE -a,
    // and only when the settlement journal actually exists (confirmedJournalId).
    // A pre-completion reorg still holds the PENDING_WITHDRAWAL obligation, so
    // no second liability (and no obligation journal) is created.
    let reorgJournalId: string | undefined;
    if (
      completionRecorded &&
      record.confirmedJournalId !== null &&
      record.reorgJournalId === null
    ) {
      try {
        const result = await this.accounting.recordObligation(record, incident);
        reorgJournalId = result.journalId;
      } catch {
        this.logger.error(
          { intentId: record.intentId, code: "OBLIGATION_JOURNAL_FAILED" },
          "failed to record reorg obligation"
        );
        await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
          reason: "obligation_journal_failed",
        });
      }
    } else if (completionRecorded && record.confirmedJournalId === null) {
      await this.openIncident("CUSTODY_FAILURE", "CRITICAL", record, {
        reason: "reorg_before_settlement_journal",
      });
    }

    await this.store.transition({
      intentId: record.intentId,
      from: [record.state],
      to: "REORGED",
      ...(reorgJournalId ? { patch: { reorgJournalId } } : {}),
    });
    await this.assets.setStatus(asset.assetId, "FROZEN", `withdrawal reorg: ${reason}`);

    return {
      intentId: record.intentId,
      action: "reorged",
      state: "REORGED",
      txHash: record.txHash,
    };
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  async reconcileAsset(assetId: string): Promise<ReconciliationOutcome> {
    const asset = await this.assets.get(assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);

    const height = await this.quorum.blockNumber(asset);
    const block =
      this.quorumAgreed(height) && height.value !== null
        ? await this.quorum.block(asset, height.value)
        : null;
    if (!block || !this.quorumAgreed(block) || block.value === null) {
      await this.incidents.open({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        assetId,
        chainId: asset.chainId,
        detail: { reason: "reconciliation_block_quorum" },
      });
      throw new Error(`Reconciliation block quorum unavailable for ${assetId}`);
    }

    const balance = await this.quorum.erc20BalanceOf(asset, asset.treasuryAddress);
    if (!this.quorumAgreed(balance) || balance.value === null) {
      await this.incidents.open({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        assetId,
        chainId: asset.chainId,
        detail: {
          reason: "reconciliation_quorum",
          observationCount: balance.observations.length,
          errorCount: balance.errors.length,
        },
      });
      throw new Error(`Reconciliation quorum unavailable for ${assetId}`);
    }

    const custodyAtomic = (balance.value ?? 0n).toString();
    const expectedAtomic = await this.accounting.expectedTreasuryAtomic(assetId);
    const mismatch = BigInt(custodyAtomic) !== BigInt(expectedAtomic);

    const evidence: ReconciliationEvidence = {
      assetId,
      chainId: asset.chainId,
      treasuryAddress: asset.treasuryAddress,
      custodyAtomic,
      expectedAtomic,
      blockNumber: block.value.number.toString(),
      blockHash: block.value.hash,
      observations: balance.observations.map((observation) => ({
        rpcUrl: observation.rpcUrl,
        valueAtomic: observation.value.toString(),
      })),
      observedAt: this.clock.now(),
      mismatch,
    };
    await this.accounting.recordReconciliation(evidence);

    if (!mismatch) {
      return { assetId, mismatch: false, custodyAtomic, expectedAtomic, incident: null };
    }

    const incident = await this.incidents.open({
      kind: "TREASURY_SHORTFALL",
      severity: "CRITICAL",
      assetId,
      chainId: asset.chainId,
      detail: { custodyAtomic, expectedAtomic, treasuryAddress: asset.treasuryAddress },
    });
    await this.assets.setStatus(assetId, "FROZEN", "treasury shortfall");
    return { assetId, mismatch: true, custodyAtomic, expectedAtomic, incident };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Agreed means the configured threshold returned the same value. A quorum on
   * `null` (e.g. all nodes agree a receipt is absent) is still a valid quorum;
   * callers that require a non-null value check it explicitly.
   */
  private quorumAgreed<T>(result: QuorumResult<T>): boolean {
    return result.agreed && result.observations.length >= this.config.minQuorum;
  }

  private async openIncident(
    kind: CustodyIncidentKind,
    severity: "WARNING" | "CRITICAL",
    record: WithdrawalRecord,
    detail: Record<string, unknown>
  ): Promise<IncidentRecord> {
    return this.incidents.open({
      kind,
      severity,
      assetId: record.assetId,
      chainId: record.chainId,
      principalId: record.principalId,
      intentId: record.intentId,
      detail,
    });
  }
}

function isConfirmationStage(state: WithdrawalState): boolean {
  return state === "PENDING_CONFIRMATION" || state === "CONFIRMED" || state === "FINALIZED";
}

/** Map a broadcaster failure to a stable, URL-free code. */
function classifyBroadcastFailure(error: unknown): BroadcastFailureCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "TransactionRejectedError" || name === "InsufficientFundsError") {
    return "BROADCAST_REJECTED";
  }
  if (name === "TimeoutError" || name === "HttpRequestError") {
    return "BROADCAST_TRANSPORT_ERROR";
  }
  return "BROADCAST_UNKNOWN";
}

/** Preserved for callers that need to reason about the exact-bytes obligation. */
export function hasExactPersistedBytes(record: WithdrawalRecord): boolean {
  return (
    isSignedWithdrawalState(record.state) && record.signedRawTx !== null && record.txHash !== null
  );
}

export type { AssetStatus, EvmAddress };
