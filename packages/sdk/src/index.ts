/**
 * @pokertools/sdk
 *
 * TypeScript SDK for PokerTools API - Real-time poker client for browser and Node.js
 *
 * @packageDocumentation
 */

// Main exports
export { PokerClient } from "./client";
export { PokerSocket } from "./socket";

// Auth helpers
export {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalTypedData,
  signWithdrawalIntent,
  generateIdempotencyKey,
} from "./auth";
export type { SiweMessageParams, WithdrawalTypedDataSigner } from "./auth";

// Utilities
export {
  formatChips,
  parseChips,
  getActivePlayer,
  getPlayerById,
  getPlayerSeat,
  isPlayerTurn,
  getTotalPot,
  getActivePlayers,
  getPlayersInHand,
  suitToEmoji,
  formatCard,
  formatCards,
  getStreetName,
  isShowdown,
  isHandComplete,
  abbreviateNumber,
} from "./utils";

// Types
export type {
  PokerSDKConfig,
  UserBalances,
  UserProfile,
  HandHistoryEntry,
  PlayerNote,
  ConnectionState,
  PokerSocketEvents,
  EventListener,
} from "./types";

export { PokerSDKError } from "./types";

// Re-export commonly used types from @pokertools/types
export type {
  PublicWirePlayer,
  PublicTableConfig,
  ServerMessage,
  ClientMessage,
  ObservationMessage,
  ErrorMessage,
  JoinTableMessage,
  LeaveTableMessage,
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  LoginRequest,
  LoginResponse,
  NonceResponse,
  LogoutResponse,
  PlayerNoteRequest,
  TableListItem,
  TournamentListItem,
  TournamentDetails,
  StartTournamentResponse,
  ReconcileTournamentResponse,
  SettleTournamentResponse,
  // Canonical protocol
  Principal,
  PrincipalKind,
  SeatObservation,
  LegalAction,
  LegalActionFamily,
  CanonicalActionRequest,
  CanonicalActionReceipt,
  CanonicalActionResult,
  PublicWireState,
  // Canonical append-only table streams (chat/events/replay)
  ChatMessage,
  ChatPage,
  ReplayFrame,
  // Canonical operational readiness
  ReadinessResponse,
  // Canonical service-credential administration
  CredentialId,
  CreateServiceCredentialRequest,
  CreatedServiceCredential,
  ServiceCredentialSummary,
  ListServiceCredentialsResponse,
  RevokeServiceCredentialResponse,
  // Canonical finance (atomic decimal strings only)
  Asset,
  AssetStatus,
  Balance as AssetBalance,
  DepositClaim,
  DepositClaimRequest,
  DepositStatus,
  WithdrawalIntent,
  WithdrawalSubmission,
  WithdrawalRecord,
  WithdrawalStatus,
  Eip712Domain,
  Eip712TypedData,
} from "@pokertools/types";

// Canonical runtime schemas and helpers
export {
  PrincipalSchema,
  SeatObservationSchema,
  LegalActionSchema,
  CanonicalActionRequestSchema,
  CanonicalActionResultSchema,
  PublicWireStateSchema,
  ObservationMessageSchema,
  ServerMessageSchema,
  safeParseServerMessage,
  ChatMessageSchema,
  ChatPageSchema,
  ReplayFrameSchema,
  ReadinessResponseSchema,
  AssetSchema,
  BalanceSchema,
  DepositClaimSchema,
  DepositClaimRequestSchema,
  WithdrawalIntentSchema,
  WithdrawalSubmissionSchema,
  WithdrawalRecordSchema,
  withdrawalIntentTypedData,
  atomicAmountToBigInt,
  bigIntToAtomicAmount,
  LoginRequestSchema,
  LoginResponseSchema,
  NonceResponseSchema,
  LogoutResponseSchema,
  CreateServiceCredentialRequestSchema,
  CreatedServiceCredentialSchema,
  ListServiceCredentialsResponseSchema,
  RevokeServiceCredentialResponseSchema,
  UserProfileSchema,
  UserBalancesSchema,
  HandHistoryEntrySchema,
  HandHistoryResponseSchema,
  PlayerNoteSchema,
  PlayerNoteRequestSchema,
  GetNotesResponseSchema,
  GetNoteResponseSchema,
  SavePlayerNoteResponseSchema,
  DeleteNoteResponseSchema,
} from "@pokertools/types";
