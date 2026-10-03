import {
  AtomicAmountSchema,
  DepositClaimRequestSchema,
  DepositProvenanceSchema,
  type DepositProvenance,
} from "@pokertools/types";
import type { DepositClaimRecord, PrismaClient } from "../../generated/prisma/index.js";
import { AtomicLedger } from "./atomic-ledger.js";
import { DepositAssetFrozenError, FinancialIntentService } from "./financial-intents.js";
import { AppError } from "../utils/errors.js";

/**
 * Canonical deposit service.
 *
 * The on-chain verification half of deposit claiming is owned by the chain
 * agent (RPC quorum, exact log identity, deep finality). That agent injects a
 * `DepositClaimVerifier` at startup. This service owns the durable, idempotent
 * credit path through the canonical atomic ledger.
 *
 * The client supplies ONLY `(assetId, txHash, logIndex)`; principal, amount,
 * status and provenance are all resolved/verified server-side.
 */

export interface DepositClaimVerificationInput {
  assetId: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  /**
   * Authenticated wallet principal. The verifier MUST bind the on-chain
   * transfer sender to this wallet; the client never supplies an amount or
   * recipient.
   */
  principalId: string;
  walletAddress: string;
}

export interface DepositClaimVerification {
  verified: boolean;
  /** Machine-readable rejection code when `verified` is false. */
  reason?: string;
  /** Required when verified; the actual on-chain amount for the log. */
  amountAtomic?: string;
  blockNumber?: string;
  blockHash?: string;
  confirmations?: number;
  provenance?: DepositProvenance;
}

export type DepositClaimVerifier = (
  input: DepositClaimVerificationInput
) => Promise<DepositClaimVerification>;

export interface ClaimInput {
  principalId: string;
  walletAddress: string;
  assetId: string;
  txHash: string;
  logIndex: number;
}

export interface ClaimResult {
  id: string;
  assetId: string;
  principalId: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  amountAtomic: string;
  blockNumber: string | null;
  blockHash: string | null;
  confirmations: number;
  status: string;
  provenance: string;
  creditedJournalId: string | null;
  idempotent: boolean;
}

/** Rejection with a stable machine code for the route layer to map. */
export class DepositClaimRejected extends AppError {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message, code === "ASSET_FROZEN" ? 409 : 400, code);
  }
}

function toClaimResult(claim: DepositClaimRecord, idempotent: boolean): ClaimResult {
  return {
    id: claim.id,
    assetId: claim.assetId,
    principalId: claim.principalId,
    chainId: claim.chainId,
    txHash: claim.txHash,
    logIndex: claim.logIndex,
    amountAtomic: claim.amountAtomic,
    blockNumber: claim.blockNumber,
    blockHash: claim.blockHash,
    confirmations: claim.confirmations,
    status: claim.status,
    provenance: claim.provenance,
    creditedJournalId: claim.creditedJournalId,
    idempotent,
  };
}

export class CanonicalDepositService {
  private readonly ledger: AtomicLedger;
  private readonly intents: FinancialIntentService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { verifier?: DepositClaimVerifier } = {}
  ) {
    this.ledger = new AtomicLedger(prisma);
    this.intents = new FinancialIntentService(prisma, this.ledger);
  }

  /**
   * Claim a direct-treasury deposit. Identity is exactly
   * `(assetId, txHash, logIndex)`. Requires a verified wallet principal; the
   * client never supplies amount, recipient or confirmations.
   */
  async claimDirectTreasury(input: ClaimInput): Promise<ClaimResult> {
    if (!input.walletAddress) {
      throw new DepositClaimRejected("WALLET_REQUIRED", "A wallet principal is required");
    }

    // Validate the strict request shape even though the principal is server-side.
    const parsed = DepositClaimRequestSchema.safeParse({
      assetId: input.assetId,
      txHash: input.txHash,
      logIndex: input.logIndex,
    });
    if (!parsed.success) {
      throw new DepositClaimRejected("VALIDATION_ERROR", "Invalid deposit claim identity");
    }

    const asset = await this.prisma.asset.findUnique({ where: { id: parsed.data.assetId } });
    if (!asset) {
      throw new DepositClaimRejected("ASSET_NOT_FOUND", "Unknown asset");
    }

    // Replay of the durable credited claim is risk-reducing and remains
    // available even while the asset is frozen. It must be the EXACT claim
    // (same asset and principal); any other existing row is a conflict and is
    // never adopted or returned.
    const existing = await this.prisma.depositClaimRecord.findUnique({
      where: {
        chainId_txHash_logIndex: {
          chainId: asset.chainId,
          txHash: parsed.data.txHash,
          logIndex: parsed.data.logIndex,
        },
      },
    });
    if (existing) {
      if (
        existing.status === "CREDITED" &&
        existing.assetId === asset.id &&
        existing.principalId === input.principalId
      ) {
        return toClaimResult(existing, true);
      }
      throw new DepositClaimRejected("DUPLICATE_CLAIM", "Deposit claim already exists");
    }

    if (asset.status === "FROZEN") {
      throw new DepositClaimRejected("ASSET_FROZEN", "Asset is frozen for financial activity");
    }

    const verifier = this.options.verifier;
    if (!verifier) {
      throw new DepositClaimRejected(
        "VERIFICATION_UNAVAILABLE",
        "Deposit verification is not available"
      );
    }

    const verification = await verifier({
      assetId: asset.id,
      chainId: asset.chainId,
      txHash: parsed.data.txHash,
      logIndex: parsed.data.logIndex,
      principalId: input.principalId,
      walletAddress: input.walletAddress,
    });
    if (!verification.verified) {
      throw new DepositClaimRejected("DEPOSIT_NOT_VERIFIED", "Deposit could not be verified");
    }

    const amount = AtomicAmountSchema.safeParse(verification.amountAtomic);
    if (!amount.success) {
      throw new DepositClaimRejected(
        "VERIFICATION_INVALID",
        "Verifier returned an invalid on-chain amount"
      );
    }
    const provenance = verification.provenance
      ? DepositProvenanceSchema.parse(verification.provenance)
      : undefined;

    let claim: DepositClaimRecord;
    try {
      claim = await this.intents.creditDepositClaim({
        principalId: input.principalId,
        assetId: asset.id,
        chainId: asset.chainId,
        txHash: parsed.data.txHash,
        logIndex: parsed.data.logIndex,
        amountAtomic: amount.data,
        blockNumber: verification.blockNumber ?? null,
        blockHash: verification.blockHash ?? null,
        confirmations: verification.confirmations ?? 0,
        provenance,
      });
    } catch (error) {
      // The credit lost the race to a freeze: surface the stable claim code so
      // the route keeps returning 409 ASSET_FROZEN rather than a generic 500.
      if (error instanceof DepositAssetFrozenError) {
        throw new DepositClaimRejected("ASSET_FROZEN", error.message);
      }
      throw error;
    }

    return toClaimResult(claim, false);
  }
}
