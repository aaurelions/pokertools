import { z } from "zod";

/**
 * Canonical wire primitives.
 *
 * These are transport-level building blocks shared by auth, table, finance and
 * operations contracts. They intentionally depend on nothing outside `zod`
 * (no env, no DB, no SDK) so the same schema validates on any runtime.
 */

/** Opaque non-empty identifier (UUID, ULID, DB id, ...). */
export const IdSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof IdSchema>;

/** Non-empty principal identifier. */
export const PrincipalIdSchema = IdSchema;
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;

/** Non-empty table identifier. */
export const TableIdSchema = IdSchema;
export type TableId = z.infer<typeof TableIdSchema>;

/** Non-empty hand identifier. */
export const HandIdSchema = IdSchema;
export type HandId = z.infer<typeof HandIdSchema>;

/** Non-empty turn identifier (decision boundary version of a seat). */
export const TurnIdSchema = IdSchema;
export type TurnId = z.infer<typeof TurnIdSchema>;

/** Non-empty legal-action identifier. */
export const ActionIdSchema = IdSchema;
export type ActionId = z.infer<typeof ActionIdSchema>;

/** Non-empty idempotent request identifier. */
export const RequestIdSchema = IdSchema;
export type RequestId = z.infer<typeof RequestIdSchema>;

/** Positive EIP-155 chain id. */
export const ChainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export type ChainId = z.infer<typeof ChainIdSchema>;

/** Non-negative, safe-integer chip quantity. */
export const ChipAmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type ChipAmount = z.infer<typeof ChipAmountSchema>;

/** Positive, safe-integer chip quantity (an amount that must move chips). */
export const PositiveChipAmountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export type PositiveChipAmount = z.infer<typeof PositiveChipAmountSchema>;

/** Non-negative, safe-integer counter (version / sequence). */
export const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type Counter = z.infer<typeof CounterSchema>;

/** Non-negative, safe-integer Unix timestamp in milliseconds. */
export const EpochMillisSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type EpochMillis = z.infer<typeof EpochMillisSchema>;

/** Non-negative, safe-integer Unix timestamp in seconds. */
export const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type EpochSeconds = z.infer<typeof EpochSecondsSchema>;

/** Lowercase 20-byte EVM address. Canonical wire form is lowercase. */
export const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "Expected lowercase EVM address");
export type EvmAddress = z.infer<typeof EvmAddressSchema>;

/** Confidential / checksum-preserving EVM address (accepts mixed case). */
export const AnyEvmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected EVM address");
export type AnyEvmAddress = z.infer<typeof AnyEvmAddressSchema>;

/** Lowercase 32-byte EVM transaction hash. */
export const TxHashSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "Expected lowercase transaction hash");
export type TxHash = z.infer<typeof TxHashSchema>;

/** Lowercase 32-byte EVM block hash. */
export const BlockHashSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "Expected lowercase block hash");
export type BlockHash = z.infer<typeof BlockHashSchema>;

/**
 * Canonical non-negative integer amount as a decimal string.
 *
 * Rules:
 * - plain base-10 digits only
 * - `0` or digits with no leading zero
 * - unsigned (no `+`), no decimal point, no exponent, no whitespace
 * - must fit in an unsigned 256-bit integer
 */
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_ATOMIC_AMOUNT = MAX_UINT256.toString();

export const AtomicAmountSchema = z
  .string()
  .max(78, "Atomic amount exceeds uint256")
  .regex(/^(0|[1-9][0-9]*)$/, "Expected canonical non-negative decimal string")
  .refine(
    (value) => !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) <= MAX_UINT256,
    "Atomic amount exceeds uint256"
  );
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;

/** Parse and validate a canonical atomic amount into a bigint. */
export function atomicAmountToBigInt(value: unknown): bigint {
  return BigInt(AtomicAmountSchema.parse(value));
}

/** Serialize a non-negative bigint into a canonical atomic amount string. */
export function bigIntToAtomicAmount(value: bigint): AtomicAmount {
  if (value < 0n || value > MAX_UINT256) {
    throw new RangeError("Atomic amount out of uint256 range");
  }
  return AtomicAmountSchema.parse(value.toString());
}
