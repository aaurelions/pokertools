/**
 * Competition REST DTOs.
 *
 * Aliases of the canonical runtime schemas in `canonical/competition.ts`; the
 * public HTTP surface and the security model are documented there. There is no
 * parallel hand-rolled declaration in this module.
 */

export type {
  AgentTableScope,
  Competition,
  CompetitionAssetAmount,
  CompetitionEntrant,
  CompetitionEntrantSpec,
  CompetitionEntryPayer,
  CompetitionEntryState,
  CompetitionEntryTerms,
  CompetitionMode,
  CompetitionPlacement,
  CompetitionPrizeStatus,
  CompetitionPrizeTerms,
  CompetitionSeatAssignment,
  CompetitionStatus,
  CompetitionTerms,
  CreateCompetitionRequest,
  CreateCompetitionResponse,
  GetCompetitionResponse,
  IssueAgentCredentialRequest,
  IssuedAgentCredential,
  OptInCompetitionRequest,
  OptInCompetitionResponse,
  SettleCompetitionRequest,
  SettleCompetitionResponse,
  StartCompetitionRequest,
  StartCompetitionResponse,
} from "../canonical/competition";

export {
  AgentTableScopeSchema,
  CompetitionAssetAmountSchema,
  CompetitionEntrantSchema,
  CompetitionEntrantSpecSchema,
  CompetitionEntryPayerSchema,
  CompetitionEntryStateSchema,
  CompetitionEntryTermsSchema,
  CompetitionModeSchema,
  CompetitionPlacementSchema,
  CompetitionPrizeStatusSchema,
  CompetitionPrizeTermsSchema,
  CompetitionSchema,
  CompetitionSeatAssignmentSchema,
  CompetitionStatusSchema,
  CompetitionTermsSchema,
  CreateCompetitionRequestSchema,
  CreateCompetitionResponseSchema,
  GetCompetitionResponseSchema,
  IssueAgentCredentialRequestSchema,
  IssuedAgentCredentialSchema,
  OptInCompetitionRequestSchema,
  OptInCompetitionResponseSchema,
  PositiveAtomicAmountSchema,
  SettleCompetitionRequestSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionRequestSchema,
  StartCompetitionResponseSchema,
} from "../canonical/competition";
