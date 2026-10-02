/**
 * Competition REST DTOs.
 *
 * Aliases of the canonical runtime schemas in `canonical/competition.ts`; the
 * public HTTP surface and the security model are documented there. There is no
 * parallel hand-rolled declaration in this module.
 */

export type {
  Competition,
  CompetitionAssetAmount,
  CompetitionEntrant,
  CompetitionEntrantSpec,
  CompetitionEntryState,
  CompetitionMode,
  CompetitionPaidTerms,
  CompetitionPlacement,
  CompetitionPrizeStatus,
  CompetitionSeatAssignment,
  CompetitionStatus,
  CreateCompetitionRequest,
  CreateCompetitionResponse,
  GetCompetitionResponse,
  OptInCompetitionRequest,
  OptInCompetitionResponse,
  SettleCompetitionRequest,
  SettleCompetitionResponse,
  StartCompetitionRequest,
  StartCompetitionResponse,
} from "../canonical/competition";

export {
  CompetitionAssetAmountSchema,
  CompetitionEntrantSchema,
  CompetitionEntrantSpecSchema,
  CompetitionEntryStateSchema,
  CompetitionModeSchema,
  CompetitionPaidTermsSchema,
  CompetitionPlacementSchema,
  CompetitionPrizeStatusSchema,
  CompetitionSchema,
  CompetitionSeatAssignmentSchema,
  CompetitionStatusSchema,
  CreateCompetitionRequestSchema,
  CreateCompetitionResponseSchema,
  GetCompetitionResponseSchema,
  OptInCompetitionRequestSchema,
  OptInCompetitionResponseSchema,
  PositiveAtomicAmountSchema,
  SettleCompetitionRequestSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionRequestSchema,
  StartCompetitionResponseSchema,
} from "../canonical/competition";
