import { z } from "zod";

/** Operator-only chip funding; no asset conversion or financial authority. */
export const GrantChipsRequestSchema = z.strictObject({
  principalId: z.string().min(1),
  // Numeric chips must be safe integers; account-level grants may use an
  // arbitrary-precision decimal string. Seating still enforces engine limits.
  amount: z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^[1-9][0-9]*$/),
  ]),
  reason: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
});
export type GrantChipsRequest = z.infer<typeof GrantChipsRequestSchema>;

export const GrantChipsResponseSchema = z.strictObject({
  success: z.literal(true),
  grantId: z.string().min(1),
  replayed: z.boolean(),
  entryId: z.string().min(1),
  balanceAfter: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
export type GrantChipsResponse = z.infer<typeof GrantChipsResponseSchema>;
