import { z } from "zod";
import {
  AtomicAmountSchema,
  BlockHashSchema,
  ChainIdSchema,
  CounterSchema,
  EvmAddressSchema,
  EpochMillisSchema,
  EpochSecondsSchema,
  IdSchema,
  PrincipalIdSchema,
  TxHashSchema,
} from "./primitives";

/**
 * Canonical finance wire contracts.
 *
 * Chips (gameplay) are separate from assets (chain value). All chain amounts
 * are canonical non-negative decimal strings (`AtomicAmountSchema`) and exact
 * log identity is `(txHash, logIndex)`.
 */

// ============================================================================
// Assets
// ============================================================================

export const AssetStatusSchema = z.enum(["ACTIVE", "DEGRADED", "FROZEN"]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

const ASSET_ID_PATTERN = /^eip155:(0|[1-9]\d*)\/erc20:(0x[0-9a-f]{40})$/;

/** Canonical asset id: `eip155:<chainId>/erc20:<lowercase token address>`. */
export const AssetIdSchema = z
  .string()
  .regex(ASSET_ID_PATTERN, "Expected eip155:<chainId>/erc20:<lowercase address>");
export type AssetId = z.infer<typeof AssetIdSchema>;

export const AssetSchema = z
  .strictObject({
    assetId: AssetIdSchema,
    chainId: ChainIdSchema,
    tokenAddress: EvmAddressSchema,
    decimals: z.number().int().min(0).max(255),
    symbol: z.string().min(1).max(32),
    status: AssetStatusSchema,
    confirmations: CounterSchema,
    deepFinality: CounterSchema,
  })
  .superRefine((asset, ctx) => {
    const match = ASSET_ID_PATTERN.exec(asset.assetId);
    if (!match) return;
    if (match[1] !== String(asset.chainId)) {
      ctx.addIssue({
        code: "custom",
        path: ["chainId"],
        message: "chainId must match the assetId chain",
      });
    }
    if (match[2] !== asset.tokenAddress) {
      ctx.addIssue({
        code: "custom",
        path: ["tokenAddress"],
        message: "tokenAddress must match the assetId token (lowercase)",
      });
    }
    if (asset.deepFinality < asset.confirmations) {
      ctx.addIssue({
        code: "custom",
        path: ["deepFinality"],
        message: "deepFinality must be at least confirmations",
      });
    }
  });
export type Asset = z.infer<typeof AssetSchema>;

// ============================================================================
// Balances
// ============================================================================

export const BalanceSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  assetId: AssetIdSchema,
  availableAtomic: AtomicAmountSchema,
  inPlayAtomic: AtomicAmountSchema,
  pendingWithdrawalAtomic: AtomicAmountSchema,
  tournamentReserveAtomic: AtomicAmountSchema.default("0"),
  incidentObligationAtomic: AtomicAmountSchema.default("0"),
});
export type Balance = z.infer<typeof BalanceSchema>;

// ============================================================================
// Deposits
// ============================================================================

export const DepositStatusSchema = z.enum([
  "OBSERVED",
  "CONFIRMED",
  "CREDITED",
  "ORPHANED",
  "FAILED",
]);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;

/**
 * How deposited value arrived. Only the direct treasury rail is supported:
 * sweep/migration provenance states were never produced by a real writer and
 * are deliberately not part of the wire vocabulary.
 */
export const DepositProvenanceSchema = z.enum(["DIRECT_TREASURY"]);
export type DepositProvenance = z.infer<typeof DepositProvenanceSchema>;

/** Exact on-chain log identity. */
export const TransactionLogRefSchema = z.strictObject({
  txHash: TxHashSchema,
  logIndex: CounterSchema,
  blockNumber: CounterSchema,
  blockHash: BlockHashSchema,
});
export type TransactionLogRef = z.infer<typeof TransactionLogRefSchema>;

/**
 * A deposit claim request. Identity is exactly `(assetId, txHash, logIndex)`;
 * the server resolves principal, amount, status and provenance itself.
 */
export const DepositClaimRequestSchema = z.strictObject({
  assetId: AssetIdSchema,
  txHash: TxHashSchema,
  logIndex: CounterSchema,
});
export type DepositClaimRequest = z.infer<typeof DepositClaimRequestSchema>;

/**
 * A resolved deposit claim response. Identity is `(assetId, txHash, logIndex)`;
 * status records settlement progress and provenance records how value arrived.
 */
export const DepositClaimSchema = z.strictObject({
  id: IdSchema,
  assetId: AssetIdSchema,
  txHash: TxHashSchema,
  logIndex: CounterSchema,
  principalId: PrincipalIdSchema,
  amountAtomic: AtomicAmountSchema,
  status: DepositStatusSchema,
  provenance: DepositProvenanceSchema,
  blockNumber: CounterSchema.optional(),
  blockHash: BlockHashSchema.optional(),
  confirmations: CounterSchema.optional(),
});
export type DepositClaim = z.infer<typeof DepositClaimSchema>;

// ============================================================================
// Withdrawals (EIP-712 bound)
// ============================================================================

export const WithdrawalStatusSchema = z.enum([
  "RESERVED",
  "BLOCKED_GAS",
  "SIGNED",
  "PERSISTED",
  "BROADCAST",
  "AMBIGUOUS",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "FINALIZED",
  "REORGED",
  "FAILED",
]);
export type WithdrawalStatus = z.infer<typeof WithdrawalStatusSchema>;

/**
 * The EIP-712 message signed by the withdrawing principal. Every field is part
 * of the signed payload; `assetId` binds the chain and token.
 */
export const WithdrawalIntentSchema = z
  .strictObject({
    intentId: IdSchema,
    principalId: PrincipalIdSchema,
    assetId: AssetIdSchema,
    destination: EvmAddressSchema,
    amountAtomic: AtomicAmountSchema,
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadline: EpochSecondsSchema,
    chainId: ChainIdSchema,
  })
  .superRefine((intent, ctx) => {
    const match = ASSET_ID_PATTERN.exec(intent.assetId);
    if (match && match[1] !== String(intent.chainId)) {
      ctx.addIssue({
        code: "custom",
        path: ["chainId"],
        message: "chainId must match the assetId chain",
      });
    }
    if (BigInt(intent.amountAtomic) === 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["amountAtomic"],
        message: "Withdrawal amount must be positive",
      });
    }
  });
export type WithdrawalIntent = z.infer<typeof WithdrawalIntentSchema>;

/** 65-byte `0x`-prefixed EVM signature (r || s || v). */
export const WithdrawalSignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
export type WithdrawalSignature = z.infer<typeof WithdrawalSignatureSchema>;

export const Eip712DomainSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  chainId: ChainIdSchema,
  verifyingContract: EvmAddressSchema,
});
export type Eip712Domain = z.infer<typeof Eip712DomainSchema>;

/** Fixed EIP-712 domain name for all withdrawal intents. */
export const WITHDRAWAL_DOMAIN_NAME = "PokerTools Withdrawal" as const;
/** Fixed EIP-712 domain version for all withdrawal intents. */
export const WITHDRAWAL_DOMAIN_VERSION = "1" as const;

/** The only EIP-712 domain accepted for withdrawal intents. */
export const WithdrawalEip712DomainSchema = z.strictObject({
  name: z.literal(WITHDRAWAL_DOMAIN_NAME),
  version: z.literal(WITHDRAWAL_DOMAIN_VERSION),
  chainId: ChainIdSchema,
  verifyingContract: EvmAddressSchema,
});
export type WithdrawalEip712Domain = z.infer<typeof WithdrawalEip712DomainSchema>;

export const Eip712TypedDataSchema = z.strictObject({
  types: z.record(z.string(), z.array(z.strictObject({ name: z.string(), type: z.string() }))),
  primaryType: z.string().min(1),
  domain: WithdrawalEip712DomainSchema,
  message: z.record(z.string(), z.unknown()),
});
export type Eip712TypedData = z.infer<typeof Eip712TypedDataSchema>;

export const WITHDRAWAL_INTENT_PRIMARY_TYPE = "WithdrawalIntent" as const;

/** Field list that must be EIP-712 bound for a withdrawal intent. */
export const WITHDRAWAL_INTENT_EIP712_FIELDS = [
  { name: "intentId", type: "string" },
  { name: "principalId", type: "string" },
  { name: "assetId", type: "string" },
  { name: "destination", type: "address" },
  { name: "amountAtomic", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "chainId", type: "uint256" },
] as const;

/**
 * Build the fixed withdrawal EIP-712 domain. Name/version are constants; the
 * verifying contract must be a validated lowercase address.
 */
export function createWithdrawalDomain(
  chainId: number,
  verifyingContract: string
): WithdrawalEip712Domain {
  return WithdrawalEip712DomainSchema.parse({
    name: WITHDRAWAL_DOMAIN_NAME,
    version: WITHDRAWAL_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  });
}

/**
 * Build the EIP-712 typed data for a withdrawal intent (encoding-agnostic).
 *
 * Enforces the fixed domain name/version, a matching `domain.chainId ===
 * intent.chainId`, and a validated verifying contract. Clients cannot override
 * the domain or inject arbitrary typed data.
 */
export function withdrawalIntentTypedData(
  intent: WithdrawalIntent,
  domain: Eip712Domain
): Eip712TypedData {
  const parsedIntent = WithdrawalIntentSchema.parse(intent);
  const parsedDomain = WithdrawalEip712DomainSchema.parse(domain);
  if (parsedDomain.chainId !== parsedIntent.chainId) {
    throw new RangeError("Withdrawal domain chainId must match the intent chainId");
  }
  return {
    types: { [WITHDRAWAL_INTENT_PRIMARY_TYPE]: [...WITHDRAWAL_INTENT_EIP712_FIELDS] },
    primaryType: WITHDRAWAL_INTENT_PRIMARY_TYPE,
    domain: parsedDomain,
    message: { ...parsedIntent },
  };
}

/**
 * Signed submission: the intent plus its signature. The API server rebuilds the
 * signature input from the intent; clients may not supply typed data.
 */
export const WithdrawalSubmissionSchema = z.strictObject({
  intent: WithdrawalIntentSchema,
  signature: WithdrawalSignatureSchema,
});
export type WithdrawalSubmission = z.infer<typeof WithdrawalSubmissionSchema>;

/**
 * Durable withdrawal lifecycle record. `REORGED` remains under monitoring:
 * recovery may rebroadcast only the exact persisted transaction, never create
 * a replacement payout or infer a refund from receipt absence. Economic
 * obligations are reconciled by durable balanced journals, not status flags.
 */
export const WithdrawalRecordSchema = WithdrawalIntentSchema.safeExtend({
  status: WithdrawalStatusSchema,
  txHash: TxHashSchema.nullable(),
  submittedAt: EpochMillisSchema.optional(),
  updatedAt: EpochMillisSchema.optional(),
});
export type WithdrawalRecord = z.infer<typeof WithdrawalRecordSchema>;
