import { z } from "zod";
import {
  AtomicAmountSchema,
  CounterSchema,
  IdSchema,
  PrincipalIdSchema,
  TableIdSchema,
} from "./primitives";
import { AssetIdSchema } from "./finance";

/**
 * Canonical tournament wire contracts.
 *
 * These are transport claims (principal-scoped) and do not duplicate the
 * existing table/tournament config schemas in `src/schemas.ts`.
 */

export const TournamentRegistrationClaimSchema = z.strictObject({
  tournamentId: IdSchema,
  principalId: PrincipalIdSchema,
  seat: z.number().int().nonnegative().max(99),
  idempotencyKey: z.string().min(1).max(128),
});
export type TournamentRegistrationClaim = z.infer<typeof TournamentRegistrationClaimSchema>;

export const TournamentSeatAssignmentSchema = z.strictObject({
  tournamentId: IdSchema,
  tableId: TableIdSchema,
  seat: z.number().int().nonnegative().max(9),
  principalId: PrincipalIdSchema,
  handId: IdSchema.optional(),
});
export type TournamentSeatAssignment = z.infer<typeof TournamentSeatAssignmentSchema>;

export const TournamentPayoutStatusSchema = z.enum(["PENDING", "CREDITED", "FAILED"]);
export type TournamentPayoutStatus = z.infer<typeof TournamentPayoutStatusSchema>;

export const TournamentPayoutSettlementSchema = z.strictObject({
  tournamentId: IdSchema,
  principalId: PrincipalIdSchema,
  placement: CounterSchema,
  assetId: AssetIdSchema,
  amountAtomic: AtomicAmountSchema,
  status: TournamentPayoutStatusSchema,
});
export type TournamentPayoutSettlement = z.infer<typeof TournamentPayoutSettlementSchema>;
