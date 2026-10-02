import crypto from "node:crypto";
import { verifyTypedData, type TypedData, type TypedDataDomain } from "viem";
import {
  AssetIdSchema,
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
  WithdrawalIntentSchema,
  createWithdrawalDomain,
  withdrawalIntentTypedData,
  type WithdrawalEip712Domain,
  type WithdrawalIntent,
} from "@pokertools/types";
import type {
  Asset,
  DepositClaimRecord,
  FinancialIncident,
  Prisma,
  PrismaClient,
  WithdrawalIntentRecord,
} from "../../generated/prisma/index.js";
import {
  AtomicLedger,
  isTransientTransactionConflict,
  isUniqueViolation,
  runTransactionWithRetry,
  type PostedJournal,
} from "./atomic-ledger.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";

// Re-exported from the shared canonical contract; do not redefine locally.
export { WITHDRAWAL_DOMAIN_NAME, WITHDRAWAL_DOMAIN_VERSION };

export interface WithdrawalPrincipal {
  id: string;
  kind: "WALLET" | "SERVICE";
  walletAddress: string | null;
}

export interface ReserveWithdrawalInput {
  principal: WithdrawalPrincipal;
  intent: WithdrawalIntent;
  signature: string;
}

export interface ReserveWithdrawalResult {
  record: WithdrawalIntentRecord;
  journal: PostedJournal | null;
  asset: Asset;
  idempotent: boolean;
}

/**
 * Canonical fingerprint of the authenticated actor bound to a signed intent.
 *
 * The idempotent replay lookup compares this over the authenticated principal,
 * every signed intent field, and the detached signature. A replay whose actor
 * or any intent field differs is a conflict — never a silent reuse of the
 * original reservation.
 */
export function withdrawalIntentFingerprint(
  principalId: string,
  intent: WithdrawalIntent,
  signature: string
): string {
  const canonical = JSON.stringify({
    principalId,
    intentId: intent.intentId,
    assetId: intent.assetId,
    destination: intent.destination,
    amountAtomic: intent.amountAtomic,
    nonce: intent.nonce,
    deadline: intent.deadline,
    chainId: intent.chainId,
    signature,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Fingerprint of a persisted intent record for idempotent comparison. */
export function withdrawalRecordFingerprint(record: WithdrawalIntentRecord): string {
  return withdrawalIntentFingerprint(
    record.principalId,
    {
      intentId: record.id,
      principalId: record.principalId,
      assetId: record.assetId,
      destination: record.destination,
      amountAtomic: record.amountAtomic,
      nonce: Number(record.nonce),
      deadline: Number(record.deadline),
      chainId: record.chainId,
    },
    record.signature
  );
}

/**
 * FinancialIntentService — durable, EIP-712-bound withdrawal intents.
 *
 * The API never holds signer secrets: it verifies the principal's detached
 * EIP-712 signature and atomically reserves funds. Signing/broadcast is owned
 * by the custody workflow, which consumes the persisted intent record.
 */
export class FinancialIntentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: AtomicLedger
  ) {}

  /** Deterministic EIP-712 domain binding an asset's treasury contract. */
  withdrawalDomain(asset: Pick<Asset, "chainId" | "treasuryAddress">): WithdrawalEip712Domain {
    return createWithdrawalDomain(asset.chainId, asset.treasuryAddress);
  }

  /** Build the exact typed data the principal must sign for an intent. */
  withdrawalTypedData(intent: WithdrawalIntent, asset: Pick<Asset, "chainId" | "treasuryAddress">) {
    return withdrawalIntentTypedData(intent, this.withdrawalDomain(asset));
  }

  /**
   * Verify that `signature` is a valid EIP-712 signature over the intent by the
   * principal's wallet address. Every intent field (including chainId) is bound.
   */
  async verifyWithdrawalSignature(params: {
    intent: WithdrawalIntent;
    signature: string;
    walletAddress: string;
    asset: Pick<Asset, "chainId" | "treasuryAddress">;
  }): Promise<boolean> {
    const intent = WithdrawalIntentSchema.parse(params.intent);
    const typedData = this.withdrawalTypedData(intent, params.asset);
    try {
      return await verifyTypedData({
        address: params.walletAddress as `0x${string}`,
        domain: typedData.domain as TypedDataDomain,
        types: typedData.types as unknown as TypedData,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: params.signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  }

  /**
   * Validate and atomically reserve a withdrawal:
   * USER_AVAILABLE -> PENDING_WITHDRAWAL in the same asset, plus a durable
   * intent record. Wallet principals only; the asset must be ACTIVE.
   */
  async reserveWithdrawal(input: ReserveWithdrawalInput): Promise<ReserveWithdrawalResult> {
    if (input.principal.kind !== "WALLET") {
      throw new AuthorizationError("Withdrawals require a wallet principal");
    }
    const walletAddress = input.principal.walletAddress;
    if (!walletAddress) {
      throw new AuthorizationError("Withdrawal principal has no wallet address");
    }

    const intent = WithdrawalIntentSchema.parse(input.intent);
    const assetId = AssetIdSchema.parse(intent.assetId);

    // The signed intent must belong to the authenticated actor. Without this,
    // any principal could submit another principal's signed intent (or one it
    // observed) and be credited the reservation. Authentication precedes the
    // duplicate lookup so a mismatch is never treated as an idempotent replay.
    if (intent.principalId !== input.principal.id) {
      throw new AuthorizationError(
        "Withdrawal intent principal does not match the authenticated principal"
      );
    }

    // Pre-flight read for fast failure only; the authoritative asset state is
    // re-read under the durable asset lock inside the transaction below.
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundError("Asset");
    }
    if (asset.status !== "ACTIVE") {
      throw new ValidationError("Asset is not active for withdrawals");
    }
    if (asset.chainId !== intent.chainId) {
      throw new ValidationError("Withdrawal chainId does not match the asset chain");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (intent.deadline < nowSeconds) {
      throw new ValidationError("Withdrawal intent has expired");
    }

    const signatureValid = await this.verifyWithdrawalSignature({
      intent,
      signature: input.signature,
      walletAddress,
      asset,
    });
    if (!signatureValid) {
      throw new AuthenticationError("Invalid withdrawal signature");
    }

    const nonce = BigInt(intent.nonce);
    const fingerprint = withdrawalIntentFingerprint(input.principal.id, intent, input.signature);

    const existing = await this.prisma.withdrawalIntentRecord.findUnique({
      where: {
        assetId_principalId_nonce: { assetId, principalId: input.principal.id, nonce },
      },
    });
    if (existing) {
      if (withdrawalRecordFingerprint(existing) !== fingerprint) {
        throw new ConflictError("Withdrawal nonce already used with different intent");
      }
      return { record: existing, journal: null, asset, idempotent: true };
    }

    const work = async (): Promise<ReserveWithdrawalResult> => {
      return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
        // Asset-first lock ordering: every ledger path takes the asset lock
        // before touching account rows, preventing deadlock.
        await this.ledger.lockAsset(tx, assetId);

        // Authoritative re-check under the durable lock. A freeze, config
        // change or blocking incident that landed after the pre-flight read
        // must prevent the debit.
        const fresh = await tx.asset.findUnique({ where: { id: assetId } });
        if (!fresh) {
          throw new NotFoundError("Asset");
        }
        if (fresh.status !== "ACTIVE") {
          throw new ValidationError("Asset is not active for withdrawals");
        }
        if (fresh.chainId !== intent.chainId) {
          throw new ValidationError("Withdrawal chainId does not match the asset chain");
        }
        // Re-verify the detached signature against the fresh treasury domain so
        // a rotated treasury/token route can never re-target a reserved intent.
        const freshSignatureValid = await this.verifyWithdrawalSignature({
          intent,
          signature: input.signature,
          walletAddress,
          asset: fresh,
        });
        if (!freshSignatureValid) {
          throw new AuthenticationError(
            "Withdrawal signature does not match the active treasury route"
          );
        }
        if (intent.deadline < Math.floor(Date.now() / 1000)) {
          throw new ValidationError("Withdrawal intent has expired");
        }

        // An open critical incident for the asset or its chain blocks new risk
        // until an operator resolves it.
        const blockingIncidents = await tx.financialIncident.count({
          where: {
            status: { not: "RESOLVED" },
            severity: "CRITICAL",
            OR: [{ assetId }, { chainId: fresh.chainId }],
          },
        });
        if (blockingIncidents > 0) {
          throw new ConflictError("Asset or chain has an open critical incident");
        }

        // Idempotency re-check under the same lock: a concurrent winner commits
        // before this writer acquires the asset lock and is observed here.
        const raced = await tx.withdrawalIntentRecord.findUnique({
          where: {
            assetId_principalId_nonce: { assetId, principalId: input.principal.id, nonce },
          },
        });
        if (raced) {
          if (withdrawalRecordFingerprint(raced) !== fingerprint) {
            throw new ConflictError("Withdrawal nonce already used with different intent");
          }
          return { record: raced, journal: null, asset: fresh, idempotent: true };
        }

        const available = await this.ledger.ensureAccount(tx, {
          assetId,
          ownerId: input.principal.id,
          class: "USER_AVAILABLE",
        });
        const pending = await this.ledger.ensureAccount(tx, {
          assetId,
          ownerId: input.principal.id,
          class: "PENDING_WITHDRAWAL",
        });

        const journal = await this.ledger.post(tx, {
          id: intent.intentId,
          requestId: intent.intentId,
          assetId,
          postings: [
            { accountId: available.accountId, amountAtomic: `-${intent.amountAtomic}` },
            { accountId: pending.accountId, amountAtomic: intent.amountAtomic },
          ],
        });

        const record = await tx.withdrawalIntentRecord.create({
          data: {
            id: intent.intentId,
            principalId: input.principal.id,
            assetId,
            chainId: intent.chainId,
            destination: intent.destination,
            amountAtomic: intent.amountAtomic,
            nonce,
            deadline: BigInt(intent.deadline),
            signature: input.signature,
            state: "RESERVED",
            reservedJournalId: journal.id,
            payloadHash: journal.payloadHash,
            // Snapshot the authorized domain route so later asset config
            // changes can never silently re-target the reserved withdrawal.
            treasuryAddress: fresh.treasuryAddress,
            tokenAddress: fresh.tokenAddress,
          },
        });

        return { record, journal, asset: fresh, idempotent: false };
      });
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        return await work();
      } catch (error) {
        lastError = error;
        // Transient SQLite/PostgreSQL write conflicts and interactive
        // transaction timeouts are retried with bounded jittered backoff; the
        // whole transaction is re-evaluated against fresh durable state.
        if (isTransientTransactionConflict(error)) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(50 * attempt, 400)));
          continue;
        }
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // Unique violation is resolved at the OUTER boundary (fresh client),
        // never by querying the aborted transaction.
        const raced = await this.prisma.withdrawalIntentRecord.findUnique({
          where: {
            assetId_principalId_nonce: { assetId, principalId: input.principal.id, nonce },
          },
        });
        if (raced) {
          if (withdrawalRecordFingerprint(raced) !== fingerprint) {
            throw new ConflictError("Withdrawal nonce already used with different intent");
          }
          return { record: raced, journal: null, asset, idempotent: true };
        }
        // Otherwise an account row was created concurrently; retry.
      }
    }
    throw lastError;
  }

  async getWithdrawalIntent(id: string): Promise<WithdrawalIntentRecord | null> {
    return this.prisma.withdrawalIntentRecord.findUnique({ where: { id } });
  }

  async listWithdrawalIntents(principalId: string, take = 50): Promise<WithdrawalIntentRecord[]> {
    return this.prisma.withdrawalIntentRecord.findMany({
      where: { principalId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  /**
   * Credit a verified deposit claim into USER_AVAILABLE, debiting the system
   * TREASURY_RESERVE. Idempotent on exact log identity. `verified` data is
   * supplied by the chain agent's verifier; this method does no RPC.
   */
  async creditDepositClaim(params: {
    principalId: string;
    assetId: string;
    chainId: number;
    txHash: string;
    logIndex: number;
    amountAtomic: string;
    blockNumber?: string | null;
    blockHash?: string | null;
    confirmations?: number;
    provenance?: "DIRECT_TREASURY" | "SWEEP" | "MIGRATION";
  }): Promise<DepositClaimRecord> {
    const assetId = AssetIdSchema.parse(params.assetId);
    const requestId = `deposit:${params.chainId}:${params.txHash}:${params.logIndex}`;

    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const existing = await tx.depositClaimRecord.findUnique({
        where: {
          chainId_txHash_logIndex: {
            chainId: params.chainId,
            txHash: params.txHash,
            logIndex: params.logIndex,
          },
        },
      });
      if (existing) {
        if (existing.status === "CREDITED") return existing;
        throw new ConflictError("Deposit claim exists without a credited journal");
      }

      await this.ledger.lockAsset(tx, assetId);

      const claim = await tx.depositClaimRecord.create({
        data: {
          assetId,
          principalId: params.principalId,
          chainId: params.chainId,
          txHash: params.txHash,
          logIndex: params.logIndex,
          amountAtomic: params.amountAtomic,
          blockNumber: params.blockNumber ?? null,
          blockHash: params.blockHash ?? null,
          confirmations: params.confirmations ?? 0,
          status: "CONFIRMED",
          provenance: params.provenance ?? "DIRECT_TREASURY",
        },
      });

      const available = await this.ledger.ensureAccount(tx, {
        assetId,
        ownerId: params.principalId,
        class: "USER_AVAILABLE",
      });
      const treasury = await this.ledger.ensureAccount(tx, {
        assetId,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });

      const journal = await this.ledger.post(tx, {
        requestId,
        assetId,
        postings: [
          { accountId: treasury.accountId, amountAtomic: `-${params.amountAtomic}` },
          { accountId: available.accountId, amountAtomic: params.amountAtomic },
        ],
      });

      return tx.depositClaimRecord.update({
        where: { id: claim.id },
        data: { status: "CREDITED", creditedJournalId: journal.id },
      });
    });
  }

  /**
   * Deposit reorg: preserve the already-credited user liability and record the
   * loss as explicit incident evidence. NO journal is posted here — crediting
   * an extra obligation would double-count what the platform owes.
   */
  async recordDepositReorg(params: {
    claimId: string;
    evidence: Record<string, unknown>;
    blockNumber?: string | null;
  }): Promise<{ claim: DepositClaimRecord; incident: FinancialIncident }> {
    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const claim = await tx.depositClaimRecord.findUnique({ where: { id: params.claimId } });
      if (!claim) {
        throw new NotFoundError("Deposit claim");
      }

      const existingIncident = await tx.financialIncident.findFirst({
        where: { kind: "DEPOSIT_REORG", affectedId: claim.id },
      });
      if (existingIncident) {
        return { claim, incident: existingIncident };
      }

      const orphaned =
        claim.status === "ORPHANED"
          ? claim
          : await tx.depositClaimRecord.update({
              where: { id: claim.id },
              data: {
                status: "ORPHANED",
                ...(params.blockNumber !== undefined ? { blockNumber: params.blockNumber } : {}),
              },
            });

      const incident = await tx.financialIncident.create({
        data: {
          kind: "DEPOSIT_REORG",
          severity: "CRITICAL",
          assetId: claim.assetId,
          chainId: claim.chainId,
          affectedId: claim.id,
          evidence: {
            ...params.evidence,
            amountAtomic: claim.amountAtomic,
            principalId: claim.principalId,
            creditedJournalId: claim.creditedJournalId,
            note: "User liability preserved; shortfall documented without duplicate liability",
          },
        },
      });

      return { claim: orphaned, incident };
    });
  }

  /**
   * Ledger-only settlement: PENDING_WITHDRAWAL -a, TREASURY_RESERVE +a.
   *
   * This posts the confirmed-payout journal and records the confirmed journal id
   * (and optional broadcast provenance) WITHOUT touching the lifecycle state.
   * The custody workflow owns the withdrawal lifecycle, so the accounting
   * adapter must use this helper rather than `settleWithdrawal`. Idempotent on
   * `withdrawal-settle:<intentId>`.
   */
  async postWithdrawalSettlementLedger(params: {
    intentId: string;
    txHash?: string | null;
    broadcastNonce?: bigint | null;
  }): Promise<{ record: WithdrawalIntentRecord; journal: PostedJournal }> {
    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const record = await tx.withdrawalIntentRecord.findUnique({ where: { id: params.intentId } });
      if (!record) {
        throw new NotFoundError("Withdrawal intent");
      }
      if (record.state === "FAILED" || record.state === "REORGED") {
        throw new ConflictError(`Cannot settle withdrawal in state ${record.state}`);
      }

      await this.ledger.lockAsset(tx, record.assetId);

      const pending = await this.ledger.ensureAccount(tx, {
        assetId: record.assetId,
        ownerId: record.principalId,
        class: "PENDING_WITHDRAWAL",
      });
      const treasury = await this.ledger.ensureAccount(tx, {
        assetId: record.assetId,
        ownerId: null,
        class: "TREASURY_RESERVE",
      });

      const journal = await this.ledger.post(tx, {
        requestId: `withdrawal-settle:${record.id}`,
        assetId: record.assetId,
        postings: [
          { accountId: pending.accountId, amountAtomic: `-${record.amountAtomic}` },
          { accountId: treasury.accountId, amountAtomic: record.amountAtomic },
        ],
      });

      const updated = await tx.withdrawalIntentRecord.update({
        where: { id: record.id },
        data: {
          ...(params.txHash !== undefined ? { txHash: params.txHash } : {}),
          ...(params.broadcastNonce !== undefined ? { broadcastNonce: params.broadcastNonce } : {}),
          confirmedJournalId: journal.id,
        },
      });

      return { record: updated, journal };
    });
  }

  /**
   * Confirmed withdrawal payout convenience wrapper.
   *
   * Posts the settlement journal, then advances the state to FINALIZED ONLY
   * when the record is still in an API-owned pre-custody state (RESERVED /
   * BLOCKED_GAS). A state the custody workflow already advanced
   * (SIGNED/PERSISTED/BROADCAST/AMBIGUOUS/PENDING_CONFIRMATION/CONFIRMED/
   * FINALIZED) is preserved so custody's deep-finality lifecycle is never
   * clobbered.
   */
  async settleWithdrawal(params: {
    intentId: string;
    txHash?: string | null;
    broadcastNonce?: bigint | null;
  }): Promise<WithdrawalIntentRecord> {
    const { record } = await this.postWithdrawalSettlementLedger(params);
    if (record.state === "RESERVED" || record.state === "BLOCKED_GAS") {
      return this.prisma.withdrawalIntentRecord.update({
        where: { id: record.id },
        data: { state: "FINALIZED" },
      });
    }
    return record;
  }

  /**
   * Withdrawal reorg.
   * - Post-completion: restores the economic obligation exactly once with
   *   INCIDENT_OBLIGATION +a / TREASURY_RESERVE -a (never debits the user).
   * - Pre-completion: retains the existing PENDING_WITHDRAWAL obligation and
   *   posts no journal.
   * Both paths open durable evidence.
   */
  async recordWithdrawalReorg(params: {
    intentId: string;
    evidence: Record<string, unknown>;
  }): Promise<{ record: WithdrawalIntentRecord; incident: FinancialIncident }> {
    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const record = await tx.withdrawalIntentRecord.findUnique({ where: { id: params.intentId } });
      if (!record) {
        throw new NotFoundError("Withdrawal intent");
      }

      const existingIncident = await tx.financialIncident.findFirst({
        where: { kind: "WITHDRAWAL_REORG", affectedId: record.id },
      });
      if (existingIncident) {
        return { record, incident: existingIncident };
      }

      const postCompletion = record.state === "FINALIZED" || record.state === "CONFIRMED";
      let reorgJournalId: string | undefined;
      if (postCompletion) {
        await this.ledger.lockAsset(tx, record.assetId);
        const obligation = await this.ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: null,
          class: "INCIDENT_OBLIGATION",
        });
        const treasury = await this.ledger.ensureAccount(tx, {
          assetId: record.assetId,
          ownerId: null,
          class: "TREASURY_RESERVE",
        });
        const journal = await this.ledger.post(tx, {
          requestId: `withdrawal-reorg:${record.id}`,
          assetId: record.assetId,
          postings: [
            { accountId: obligation.accountId, amountAtomic: record.amountAtomic },
            { accountId: treasury.accountId, amountAtomic: `-${record.amountAtomic}` },
          ],
        });
        reorgJournalId = journal.id;
      }

      const updated = await tx.withdrawalIntentRecord.update({
        where: { id: record.id },
        data: {
          state: "REORGED",
          ...(reorgJournalId !== undefined ? { reorgJournalId } : {}),
        },
      });

      const incident = await tx.financialIncident.create({
        data: {
          kind: "WITHDRAWAL_REORG",
          severity: "CRITICAL",
          assetId: record.assetId,
          chainId: record.chainId,
          affectedId: record.id,
          evidence: {
            ...params.evidence,
            amountAtomic: record.amountAtomic,
            principalId: record.principalId,
            priorState: record.state,
            postCompletion,
            note: postCompletion
              ? "Obligation restored once via INCIDENT_OBLIGATION; user not debited"
              : "Pending obligation retained; no duplicate liability",
          },
        },
      });

      return { record: updated, incident };
    });
  }
}
