import type {
  AtomicAccountClass,
  ChipAssetConversionDirection,
  EconomicPolicy,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/index.js";
import { AtomicLedger, serializeSignedAtomic } from "./atomic-ledger.js";
import { AppError, ValidationError } from "../utils/errors.js";

/**
 * Exact chip <-> asset conversion policy and settlement.
 *
 * Chips are integer gameplay units. An asset has atomic units. A persisted
 * EconomicPolicy defines the ONLY permitted exchange rate:
 *
 *     atomic = chips * atomicDenominator / chipsNumerator
 *
 * Two levels of exactness are enforced:
 *
 *  1. `requirePolicy` (used by every real operation) requires the rate to be
 *     representable by a single chip as an integer atomic amount, i.e.
 *     `atomicDenominator % chipsNumerator == 0`. This guarantees that ANY
 *     integer chip amount (including odd pot payouts) converts exactly and no
 *     operation can trap funds with an unrepresentable fraction.
 *  2. The pure helpers `chipsToAtomicExact` / `atomicToChipsExact` additionally
 *     support rational rates but still refuse a division with a remainder.
 *
 * There is no default rate (no 1-chip = 1-cent assumption) and no silent
 * rounding anywhere.
 *
 * ASSET-backed hand settlement moves atomic liability between per-principal
 * IN_PLAY_RESERVE accounts and credits atomic rake to OPERATOR inside one
 * balanced journal transaction that shares the chip settlement transaction.
 */

export class EconomicPolicyError extends AppError {
  constructor(message: string, statusCode = 400, code = "ECONOMIC_POLICY_INVALID") {
    super(message, statusCode, code);
  }
}

export interface ResolvedEconomicPolicy {
  id: string;
  assetId: string;
  chipsNumerator: bigint;
  atomicDenominator: bigint;
  /** Atomic units represented by exactly one chip. Always an integer. */
  atomicPerChip: bigint;
  version: number;
  status: EconomicPolicy["status"];
}

export type EconomicScopeType = "TABLE" | "TOURNAMENT";

export interface AccountSpec {
  class: AtomicAccountClass;
  ownerId: string | null;
}

export interface EconomicConversionResult {
  conversionId: string;
  assetId: string;
  chipAmount: bigint;
  atomicAmount: string;
  journalRequestId: string;
  replayed: boolean;
}

export interface SettlementDelta {
  principalId: string;
  /** Signed integer chip net change for this hand. */
  chips: bigint;
}

export interface EconomicSettlementResult {
  settlementId: string;
  journalRequestId: string;
  rakeAtomic: string;
  replayed: boolean;
}

export function validatePolicyTerms(policy: {
  chipsNumerator: bigint;
  atomicDenominator: bigint;
}): void {
  if (policy.chipsNumerator <= 0n) {
    throw new EconomicPolicyError("chipsNumerator must be a positive integer");
  }
  if (policy.atomicDenominator <= 0n) {
    throw new EconomicPolicyError("atomicDenominator must be a positive integer");
  }
}

/**
 * Conservative production rule: one chip must map to a whole number of atomic
 * units so every possible integer chip amount converts exactly.
 * Returns the atomic amount represented by one chip.
 */
export function assertOneChipRepresentable(policy: {
  chipsNumerator: bigint;
  atomicDenominator: bigint;
}): bigint {
  validatePolicyTerms(policy);
  if (policy.atomicDenominator % policy.chipsNumerator !== 0n) {
    throw new EconomicPolicyError(
      `Economic policy is not one-chip representable: ${policy.chipsNumerator} chip(s) = ` +
        `${policy.atomicDenominator} atomic does not map a single chip to an integer`,
      409,
      "ECONOMIC_POLICY_NOT_REPRESENTABLE"
    );
  }
  return policy.atomicDenominator / policy.chipsNumerator;
}

/** Exact conversion of an integer chip amount into atomic asset units. */
export function chipsToAtomicExact(
  policy: Pick<EconomicPolicy, "chipsNumerator" | "atomicDenominator">,
  chips: bigint
): bigint {
  validatePolicyTerms(policy);
  if (chips <= 0n) {
    throw new EconomicPolicyError("chip amount must be a positive integer");
  }
  const product = chips * policy.atomicDenominator;
  if (product % policy.chipsNumerator !== 0n) {
    throw new EconomicPolicyError(
      `Chip amount ${chips} does not convert exactly under policy ` +
        `(${policy.chipsNumerator} chips = ${policy.atomicDenominator} atomic)`
    );
  }
  return product / policy.chipsNumerator;
}

/** Exact conversion of an atomic asset amount into an integer chip amount. */
export function atomicToChipsExact(
  policy: Pick<EconomicPolicy, "chipsNumerator" | "atomicDenominator">,
  atomic: bigint
): bigint {
  validatePolicyTerms(policy);
  if (atomic <= 0n) {
    throw new EconomicPolicyError("atomic amount must be a positive integer");
  }
  const product = atomic * policy.chipsNumerator;
  if (product % policy.atomicDenominator !== 0n) {
    throw new EconomicPolicyError(
      `Atomic amount ${atomic} does not convert exactly under policy ` +
        `(${policy.chipsNumerator} chips = ${policy.atomicDenominator} atomic)`
    );
  }
  return product / policy.atomicDenominator;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

export class EconomicPolicyService {
  private readonly ledger: AtomicLedger;

  constructor(private readonly prisma: PrismaClient) {
    this.ledger = new AtomicLedger(prisma);
  }

  // ==========================================================================
  // Policy resolution
  // ==========================================================================

  async resolveTablePolicy(
    client: Prisma.TransactionClient | PrismaClient,
    tableId: string
  ): Promise<ResolvedEconomicPolicy | null> {
    const table = await client.table.findUnique({
      where: { id: tableId },
      select: { economicPolicyId: true },
    });
    if (!table) throw new EconomicPolicyError("Table not found", 404, "TABLE_NOT_FOUND");
    if (!table.economicPolicyId) return null;
    return this.requirePolicy(client, table.economicPolicyId);
  }

  async resolveTournamentPolicy(
    client: Prisma.TransactionClient | PrismaClient,
    tournamentId: string
  ): Promise<ResolvedEconomicPolicy | null> {
    const tournament = await client.tournament.findUnique({
      where: { id: tournamentId },
      select: { economicPolicyId: true },
    });
    if (!tournament) {
      throw new EconomicPolicyError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    if (!tournament.economicPolicyId) return null;
    return this.requirePolicy(client, tournament.economicPolicyId);
  }

  async requirePolicy(
    client: Prisma.TransactionClient | PrismaClient,
    policyId: string
  ): Promise<ResolvedEconomicPolicy> {
    const policy = await client.economicPolicy.findUnique({ where: { id: policyId } });
    if (!policy) {
      throw new EconomicPolicyError("Economic policy not found", 404, "ECONOMIC_POLICY_NOT_FOUND");
    }
    if (policy.status !== "ACTIVE") {
      throw new EconomicPolicyError(
        `Economic policy ${policy.id} is ${policy.status}; only ACTIVE policies may convert`,
        409,
        "ECONOMIC_POLICY_NOT_ACTIVE"
      );
    }
    const atomicPerChip = assertOneChipRepresentable(policy);
    return {
      id: policy.id,
      assetId: policy.assetId,
      chipsNumerator: policy.chipsNumerator,
      atomicDenominator: policy.atomicDenominator,
      atomicPerChip,
      version: policy.version,
      status: policy.status,
    };
  }

  // ==========================================================================
  // Deposit / withdrawal of reserve liability
  // ==========================================================================

  /** Buy-in: user available atomic -> in-play/tournament reserve. */
  async convertChipsToAtomic(
    client: Prisma.TransactionClient,
    input: {
      policy: ResolvedEconomicPolicy;
      principalId: string;
      scopeType: EconomicScopeType;
      scopeId: string;
      chips: bigint;
      idempotencyKey: string;
    }
  ): Promise<EconomicConversionResult> {
    const atomic = chipsToAtomicExact(input.policy, input.chips);
    return this.commitConversion(client, {
      direction: "CHIPS_TO_ATOMIC",
      policy: input.policy,
      principalId: input.principalId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      chips: input.chips,
      atomic,
      requestId: this.requestId("chips_to_atomic", input, input.principalId),
      idempotencyKey: input.idempotencyKey,
      from: { class: "USER_AVAILABLE", ownerId: input.principalId },
      // Table reserves are per-principal so settlement can move liability
      // between specific players; tournament reserves are a shared pool.
      to:
        input.scopeType === "TABLE"
          ? { class: "IN_PLAY_RESERVE", ownerId: input.principalId }
          : { class: "TOURNAMENT_RESERVE", ownerId: null },
    });
  }

  /** Cash-out/refund: reserve -> user available atomic. */
  async convertAtomicToChips(
    client: Prisma.TransactionClient,
    input: {
      policy: ResolvedEconomicPolicy;
      principalId: string;
      scopeType: EconomicScopeType;
      scopeId: string;
      chips: bigint;
      idempotencyKey: string;
      direction?: "ATOMIC_TO_CHIPS" | "TOURNAMENT_PAYOUT";
    }
  ): Promise<EconomicConversionResult> {
    const atomic = chipsToAtomicExact(input.policy, input.chips);
    return this.commitConversion(client, {
      direction: input.direction ?? "ATOMIC_TO_CHIPS",
      policy: input.policy,
      principalId: input.principalId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      chips: input.chips,
      atomic,
      requestId: this.requestId("atomic_to_chips", input, input.principalId),
      idempotencyKey: input.idempotencyKey,
      from:
        input.scopeType === "TABLE"
          ? { class: "IN_PLAY_RESERVE", ownerId: input.principalId }
          : { class: "TOURNAMENT_RESERVE", ownerId: null },
      to: { class: "USER_AVAILABLE", ownerId: input.principalId },
    });
  }

  /** Operator fee: user available atomic -> operator. */
  async convertFeeToOperator(
    client: Prisma.TransactionClient,
    input: {
      policy: ResolvedEconomicPolicy;
      principalId: string;
      operatorId: string;
      scopeType: EconomicScopeType;
      scopeId: string;
      chips: bigint;
      idempotencyKey: string;
    }
  ): Promise<EconomicConversionResult> {
    const atomic = chipsToAtomicExact(input.policy, input.chips);
    return this.commitConversion(client, {
      direction: "TOURNAMENT_FEE",
      policy: input.policy,
      principalId: input.principalId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      chips: input.chips,
      atomic,
      requestId: this.requestId("fee", input, input.principalId),
      idempotencyKey: input.idempotencyKey,
      from: { class: "USER_AVAILABLE", ownerId: input.principalId },
      to: { class: "OPERATOR", ownerId: input.operatorId },
    });
  }

  // ==========================================================================
  // Hand settlement
  // ==========================================================================

  /**
   * Apply one ASSET-backed hand settlement as a single balanced atomic journal:
   * each loser's IN_PLAY_RESERVE is debited, each winner's IN_PLAY_RESERVE is
   * credited, and rake is credited to OPERATOR. Because
   * `sum(netChanges) + rake == 0`, the postings sum to exactly zero.
   *
   * The per-principal chip/atomic mapping is persisted in ChipAssetSettlement so
   * a concurrent or repeated settlement of the same hand is a no-op.
   */
  async settleHandAtomic(
    client: Prisma.TransactionClient,
    input: {
      policy: ResolvedEconomicPolicy;
      scopeType: EconomicScopeType;
      scopeId: string;
      referenceId: string;
      deltas: SettlementDelta[];
      rake: bigint;
      operatorId: string;
    }
  ): Promise<EconomicSettlementResult> {
    if (input.rake < 0n) throw new EconomicPolicyError("rake must not be negative");
    const journalRequestId = `asset-settle:${input.scopeType.toLowerCase()}:${input.scopeId}:${input.referenceId}`;

    const existing = await client.chipAssetSettlement.findUnique({
      where: {
        scopeType_scopeId_referenceId: {
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          referenceId: input.referenceId,
        },
      },
    });
    if (existing) {
      return {
        settlementId: existing.id,
        journalRequestId: existing.journalRequestId,
        rakeAtomic: existing.rakeAtomic,
        replayed: true,
      };
    }

    const postings: Array<{ accountId: string; amountAtomic: string }> = [];
    const breakdown: Array<{ principalId: string; chips: string; atomic: string }> = [];
    let netChips = 0n;

    for (const delta of input.deltas) {
      netChips += delta.chips;
      if (delta.chips === 0n) continue;
      const atomic = chipsToAtomicExact(
        input.policy,
        delta.chips < 0n ? -delta.chips : delta.chips
      );
      const signed = delta.chips > 0n ? atomic : -atomic;
      const account = await this.ledger.ensureAccount(client, {
        assetId: input.policy.assetId,
        ownerId: delta.principalId,
        class: "IN_PLAY_RESERVE",
      });
      postings.push({
        accountId: account.accountId,
        amountAtomic: serializeSignedAtomic(signed),
      });
      breakdown.push({
        principalId: delta.principalId,
        chips: delta.chips.toString(),
        atomic: signed.toString(),
      });
    }

    if (netChips + input.rake !== 0n) {
      throw new EconomicPolicyError(
        `Unbalanced asset settlement for ${input.referenceId}: net ${netChips}, rake ${input.rake}`
      );
    }

    let rakeAtomic = 0n;
    if (input.rake > 0n) {
      rakeAtomic = chipsToAtomicExact(input.policy, input.rake);
      const operator = await this.ledger.ensureAccount(client, {
        assetId: input.policy.assetId,
        ownerId: input.operatorId,
        class: "OPERATOR",
      });
      postings.push({
        accountId: operator.accountId,
        amountAtomic: serializeSignedAtomic(rakeAtomic),
      });
    }

    if (postings.length === 0) {
      // Nothing moved; still persist the no-op settlement for idempotency.
    } else {
      await this.ledger.post(client, {
        requestId: journalRequestId,
        assetId: input.policy.assetId,
        postings,
      });
    }

    try {
      const settlement = await client.chipAssetSettlement.create({
        data: {
          economicPolicyId: input.policy.id,
          assetId: input.policy.assetId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          referenceId: input.referenceId,
          journalRequestId,
          rakeAtomic: rakeAtomic.toString(),
          breakdown: { journalRequestId, deltas: breakdown },
        },
      });
      return {
        settlementId: settlement.id,
        journalRequestId: settlement.journalRequestId,
        rakeAtomic: settlement.rakeAtomic,
        replayed: false,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await client.chipAssetSettlement.findUniqueOrThrow({
          where: {
            scopeType_scopeId_referenceId: {
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              referenceId: input.referenceId,
            },
          },
        });
        return {
          settlementId: raced.id,
          journalRequestId: raced.journalRequestId,
          rakeAtomic: raced.rakeAtomic,
          replayed: true,
        };
      }
      throw error;
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private requestId(
    operation: string,
    input: { scopeType: string; scopeId: string; idempotencyKey: string },
    suffix: string
  ): string {
    return [
      "chip-asset",
      operation,
      input.scopeType.toLowerCase(),
      input.scopeId,
      suffix,
      input.idempotencyKey,
    ].join(":");
  }

  private async commitConversion(
    client: Prisma.TransactionClient,
    input: {
      direction: ChipAssetConversionDirection;
      policy: ResolvedEconomicPolicy;
      principalId: string;
      scopeType: EconomicScopeType;
      scopeId: string;
      chips: bigint;
      atomic: bigint;
      requestId: string;
      idempotencyKey: string;
      from: AccountSpec;
      to: AccountSpec;
    }
  ): Promise<EconomicConversionResult> {
    const existing = await client.chipAssetConversion.findFirst({
      where: {
        OR: [{ journalRequestId: input.requestId }, { idempotencyKey: input.idempotencyKey }],
      },
    });
    if (existing) {
      if (
        existing.chipAmount !== input.chips ||
        BigInt(existing.atomicAmount) !== input.atomic ||
        existing.direction !== input.direction
      ) {
        throw new EconomicPolicyError(
          "Conversion was already recorded with different terms",
          409,
          "ECONOMIC_CONVERSION_CONFLICT"
        );
      }
      return {
        conversionId: existing.id,
        assetId: existing.assetId,
        chipAmount: existing.chipAmount,
        atomicAmount: existing.atomicAmount,
        journalRequestId: existing.journalRequestId,
        replayed: true,
      };
    }

    const from = await this.ledger.ensureAccount(client, {
      assetId: input.policy.assetId,
      ownerId: input.from.ownerId,
      class: input.from.class,
    });
    const to = await this.ledger.ensureAccount(client, {
      assetId: input.policy.assetId,
      ownerId: input.to.ownerId,
      class: input.to.class,
    });

    await this.ledger.post(client, {
      requestId: input.requestId,
      assetId: input.policy.assetId,
      postings: [
        { accountId: from.accountId, amountAtomic: serializeSignedAtomic(-input.atomic) },
        { accountId: to.accountId, amountAtomic: serializeSignedAtomic(input.atomic) },
      ],
    });

    try {
      const conversion = await client.chipAssetConversion.create({
        data: {
          principalId: input.principalId,
          economicPolicyId: input.policy.id,
          direction: input.direction,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          chipAmount: input.chips,
          atomicAmount: input.atomic.toString(),
          assetId: input.policy.assetId,
          journalRequestId: input.requestId,
          status: "COMMITTED",
          idempotencyKey: input.idempotencyKey,
          metadata: {
            policyVersion: input.policy.version,
            chipsNumerator: input.policy.chipsNumerator.toString(),
            atomicDenominator: input.policy.atomicDenominator.toString(),
            atomicPerChip: input.policy.atomicPerChip.toString(),
          },
        },
      });
      return {
        conversionId: conversion.id,
        assetId: conversion.assetId,
        chipAmount: conversion.chipAmount,
        atomicAmount: conversion.atomicAmount,
        journalRequestId: conversion.journalRequestId,
        replayed: false,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await client.chipAssetConversion.findFirstOrThrow({
          where: {
            OR: [{ journalRequestId: input.requestId }, { idempotencyKey: input.idempotencyKey }],
          },
        });
        return {
          conversionId: raced.id,
          assetId: raced.assetId,
          chipAmount: raced.chipAmount,
          atomicAmount: raced.atomicAmount,
          journalRequestId: raced.journalRequestId,
          replayed: true,
        };
      }
      throw error;
    }
  }

  /** Validate external caller-supplied policy term pair (pure positivity). */
  static validateTerms(chipsNumerator: bigint, atomicDenominator: bigint): void {
    if (!Number.isInteger(Number(chipsNumerator)) || !Number.isInteger(Number(atomicDenominator))) {
      throw new ValidationError("Policy terms must be integers");
    }
    validatePolicyTerms({ chipsNumerator, atomicDenominator });
  }
}
