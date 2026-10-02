import { z } from "zod";
import { LegalActionSchema } from "@pokertools/types";

/**
 * Test-side observation schema.
 *
 * The shared `SeatObservationSchema` requires a non-null `turnId` and a
 * fully-formed masked state with a non-empty `handId`. The current game
 * authority returns `null` at hand boundaries and may not have a hand yet, so
 * this schema validates the decision envelope and legal actions while leaving
 * the masked state as an opaque record. Masking invariants are asserted
 * explicitly by the tests (deck empty, previousStates empty, only the viewer's
 * hole cards visible), so a permissive state here cannot hide a masking bug.
 */
export const SaferSeatObservationSchema = z.object({
  tableId: z.string().min(1),
  handId: z.string(),
  turnId: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  eventSeq: z.number().int().nonnegative(),
  state: z.record(z.string(), z.unknown()),
  legalActions: z.array(LegalActionSchema),
});
