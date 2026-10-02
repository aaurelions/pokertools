import { z } from "zod";
import { ErrorCodes } from "../error-codes";
import {
  AnyEvmAddressSchema,
  ChipAmountSchema,
  CounterSchema,
  IdSchema,
  PositiveChipAmountSchema,
} from "./primitives";
import { BalanceSchema } from "./finance";
import { PrincipalRoleSchema, ServiceScopeSchema } from "./principal";
import { PublicTableConfigSchema, PublicWireStateSchema } from "./masked-state";

/**
 * Canonical REST wire schemas for the remaining hand-rolled / interface-only
 * DTOs. These replace parallel DTO definitions so the API, SDK and clients
 * validate against one contract. Existing schemas in `src/schemas.ts` and
 * `src/api/operations.ts` are preserved unchanged.
 */

// ============================================================================
// Errors
// ============================================================================

export const ErrorCodeSchema = z.enum(
  Object.values(ErrorCodes) as [keyof typeof ErrorCodes, ...Array<keyof typeof ErrorCodes>]
);
export type ErrorCodeWire = z.infer<typeof ErrorCodeSchema>;

/** Canonical public error envelope. `context` must never carry secrets. */
export const ErrorResponseSchema = z.strictObject({
  error: ErrorCodeSchema,
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  statusCode: z.number().int().min(400).max(599).optional(),
});
export type ErrorResponseWire = z.infer<typeof ErrorResponseSchema>;

// ============================================================================
// Auth (SIWE + sessions + scoped service credentials)
// ============================================================================

export const LoginRequestSchema = z.strictObject({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "Invalid signature format"),
});
export type LoginRequestWire = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.strictObject({
  token: z.string().min(1),
  user: z.strictObject({
    id: IdSchema,
    username: z.string().min(1),
  }),
});
export type LoginResponseWire = z.infer<typeof LoginResponseSchema>;

export const NonceResponseSchema = z.strictObject({
  nonce: z.string().min(1),
});
export type NonceResponseWire = z.infer<typeof NonceResponseSchema>;

export const LogoutResponseSchema = z.strictObject({
  success: z.literal(true),
});
export type LogoutResponseWire = z.infer<typeof LogoutResponseSchema>;

/**
 * Opaque service credential id. Matches the id format the API mints and the
 * `/:id/revoke` path constraint; it is never a wallet id.
 */
export const CredentialIdSchema = z.string().regex(/^[a-z0-9]{16,40}$/i, "Invalid credential id");
export type CredentialIdWire = z.infer<typeof CredentialIdSchema>;

const ServiceCredentialNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9 _.:-]+$/, "Invalid credential name");
const ServiceCredentialTableIdSchema = z.string().min(1).max(64);
const IsoDateTimeSchema = z.string().datetime();
const NullableIsoDateTimeSchema = IsoDateTimeSchema.nullable();

/** `POST /auth/service-credentials` (operator-only, ADMIN wallet). */
export const CreateServiceCredentialRequestSchema = z
  .strictObject({
    name: ServiceCredentialNameSchema,
    scopes: z.array(ServiceScopeSchema).min(1).max(3),
    tableId: ServiceCredentialTableIdSchema.optional(),
    seat: z.number().int().min(0).max(9).optional(),
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .refine((value) => value.seat === undefined || value.tableId !== undefined, {
    message: "seat restriction requires tableId",
    path: ["seat"],
  });
export type CreateServiceCredentialRequestWire = z.infer<
  typeof CreateServiceCredentialRequestSchema
>;

/**
 * `POST /auth/service-credentials` response. The plaintext `token` is returned
 * exactly once; only its digest is persisted.
 */
export const CreatedServiceCredentialSchema = z.strictObject({
  id: CredentialIdSchema,
  userId: IdSchema,
  name: z.string().min(1),
  scopes: z.array(ServiceScopeSchema).min(1),
  tableId: ServiceCredentialTableIdSchema.nullable(),
  seat: z.number().int().min(0).max(9).nullable(),
  expiresAt: NullableIsoDateTimeSchema,
  token: z.string().min(1),
});
export type CreatedServiceCredentialWire = z.infer<typeof CreatedServiceCredentialSchema>;

/** `GET /auth/service-credentials` row (never carries the plaintext token). */
export const ServiceCredentialSummarySchema = z.strictObject({
  id: CredentialIdSchema,
  userId: IdSchema,
  name: z.string().min(1),
  scopes: z.array(ServiceScopeSchema),
  tableId: ServiceCredentialTableIdSchema.nullable(),
  seat: z.number().int().min(0).max(9).nullable(),
  revoked: z.boolean(),
  expiresAt: NullableIsoDateTimeSchema,
  lastUsedAt: NullableIsoDateTimeSchema,
  revokedAt: NullableIsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type ServiceCredentialSummaryWire = z.infer<typeof ServiceCredentialSummarySchema>;

export const ListServiceCredentialsResponseSchema = z.strictObject({
  credentials: z.array(ServiceCredentialSummarySchema),
});
export type ListServiceCredentialsResponseWire = z.infer<
  typeof ListServiceCredentialsResponseSchema
>;

export const RevokeServiceCredentialResponseSchema = z.strictObject({
  success: z.literal(true),
});
export type RevokeServiceCredentialResponseWire = z.infer<
  typeof RevokeServiceCredentialResponseSchema
>;

// ============================================================================
// User profile, chip balances and hand history
// ============================================================================

/** Canonical non-negative decimal chip quantity (integer chips, not assets). */
const DecimalChipStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "Expected canonical chip decimal string");

/**
 * Gameplay chip projection for `GET /user/me`. Deliberately decimal strings and
 * separate from per-asset atomic balances (`Balance`); there is no cents or
 * default-currency conversion.
 */
export const UserBalancesSchema = z.strictObject({
  available: DecimalChipStringSchema,
  inPlay: DecimalChipStringSchema,
  tournament: DecimalChipStringSchema,
  totalInPlay: DecimalChipStringSchema,
  pendingWithdrawal: DecimalChipStringSchema,
});
export type UserBalances = z.infer<typeof UserBalancesSchema>;

/**
 * `GET /user/me` profile. `address` is the wallet address for WALLET
 * principals and `null` for SERVICE identities; it is never a fabricated
 * default wallet.
 */
export const UserProfileSchema = z.strictObject({
  id: IdSchema,
  username: z.string().min(1).max(64),
  address: AnyEvmAddressSchema.nullable(),
  role: PrincipalRoleSchema,
  createdAt: IsoDateTimeSchema,
  chipBalances: UserBalancesSchema,
  assetBalances: z.array(BalanceSchema),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

const HandHistoryEntryTypeSchema = z.enum(["HAND_WIN", "HAND_LOSS"]);
export type HandHistoryEntryType = z.infer<typeof HandHistoryEntryTypeSchema>;

export const HandHistoryEntrySchema = z.strictObject({
  id: IdSchema,
  amount: ChipAmountSchema,
  type: HandHistoryEntryTypeSchema,
  referenceId: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type HandHistoryEntry = z.infer<typeof HandHistoryEntrySchema>;

export const HandHistoryResponseSchema = z.strictObject({
  history: z.array(HandHistoryEntrySchema),
});
export type HandHistoryResponse = z.infer<typeof HandHistoryResponseSchema>;

// ============================================================================
// Player notes
// ============================================================================

export const PlayerNoteTargetSchema = z.strictObject({
  id: IdSchema,
  username: z.string().min(1),
});
export type PlayerNoteTarget = z.infer<typeof PlayerNoteTargetSchema>;

export const PlayerNoteSchema = z.strictObject({
  id: IdSchema,
  authorId: IdSchema,
  targetId: IdSchema,
  content: z.string().max(500),
  label: z.string().max(100).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Present on list responses, absent on the single-note/upsert responses. */
  target: PlayerNoteTargetSchema.optional(),
});
export type PlayerNote = z.infer<typeof PlayerNoteSchema>;

export const PlayerNoteRequestSchema = z.strictObject({
  targetId: IdSchema,
  content: z.string().max(500),
  label: z.string().max(100).optional(),
});
export type PlayerNoteRequest = z.infer<typeof PlayerNoteRequestSchema>;

export const SavePlayerNoteResponseSchema = z.strictObject({
  success: z.literal(true),
  note: PlayerNoteSchema,
});
export type SavePlayerNoteResponse = z.infer<typeof SavePlayerNoteResponseSchema>;

export const GetNotesResponseSchema = z.strictObject({
  notes: z.array(PlayerNoteSchema),
});
export type GetNotesResponse = z.infer<typeof GetNotesResponseSchema>;

export const GetNoteResponseSchema = z.strictObject({
  note: PlayerNoteSchema.nullable(),
});
export type GetNoteResponse = z.infer<typeof GetNoteResponseSchema>;

export const DeleteNoteResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string().min(1),
});
export type DeleteNoteResponse = z.infer<typeof DeleteNoteResponseSchema>;

// ============================================================================
// Table list
// ============================================================================

export const GameModeSchema = z.enum(["CASH", "TOURNAMENT"]);
export type GameModeWire = z.infer<typeof GameModeSchema>;

export const TableStatusSchema = z.enum(["WAITING", "ACTIVE", "PAUSED", "CLOSED"]);
export type TableStatusWire = z.infer<typeof TableStatusSchema>;

/** Persisted room configuration includes creation metadata, unlike an engine view. */
export const TableListingConfigSchema = PublicTableConfigSchema.extend({
  name: z.string().min(1).optional(),
  mode: z.enum(["CASH", "TOURNAMENT"]).optional(),
  minBuyIn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxBuyIn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  startingStack: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const TableListItemSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  config: TableListingConfigSchema,
  status: TableStatusSchema,
});
export type TableListItemWire = z.infer<typeof TableListItemSchema>;

export const GetTablesResponseSchema = z.strictObject({
  tables: z.array(TableListItemSchema),
});
export type GetTablesResponseWire = z.infer<typeof GetTablesResponseSchema>;

/** Conditional table reads and observations share exactly one masked wire state. */
export const GetTableStateResponseSchema = z.strictObject({ state: PublicWireStateSchema });
export type GetTableStateResponseWire = z.infer<typeof GetTableStateResponseSchema>;

// ============================================================================
// Tournaments
// ============================================================================

export const TournamentStatusSchema = z.enum(["REGISTRATION", "RUNNING", "FINISHED", "CANCELLED"]);
export type TournamentStatusWire = z.infer<typeof TournamentStatusSchema>;

export const TournamentEntryStatusSchema = z.enum(["REGISTERED", "ACTIVE", "ELIMINATED", "PAID"]);
export type TournamentEntryStatusWire = z.infer<typeof TournamentEntryStatusSchema>;

export const TournamentEntrySchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  username: z.string().optional(),
  seat: z.number().int().nonnegative().max(99),
  status: TournamentEntryStatusSchema,
  placement: CounterSchema.nullable().optional(),
  prize: ChipAmountSchema,
  currentTableId: z.string().min(1).nullable().optional(),
  currentSeat: z.number().int().nonnegative().max(9).nullable().optional(),
});
export type TournamentEntryWire = z.infer<typeof TournamentEntrySchema>;

export const TournamentTableInfoSchema = z.strictObject({
  id: z.string().min(1),
  status: z.string().min(1),
  playerCount: CounterSchema,
});
export type TournamentTableInfoWire = z.infer<typeof TournamentTableInfoSchema>;

export const TournamentListItemSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  status: TournamentStatusSchema,
  tableId: z.string().min(1),
  buyIn: ChipAmountSchema,
  fee: ChipAmountSchema,
  startingStack: PositiveChipAmountSchema,
  maxPlayers: z.number().int().min(2).max(100),
  tableMaxPlayers: z.number().int().min(2).max(10),
  balancingTolerance: z.number().int().min(0).max(5),
  registeredPlayers: CounterSchema,
  prizePool: ChipAmountSchema,
  startsAt: z.string().datetime().nullable().optional(),
});
export type TournamentListItemWire = z.infer<typeof TournamentListItemSchema>;

export const TournamentDetailsSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  status: TournamentStatusSchema,
  tableId: z.string().min(1),
  buyIn: ChipAmountSchema,
  fee: ChipAmountSchema,
  startingStack: PositiveChipAmountSchema,
  maxPlayers: z.number().int().min(2).max(100),
  tableMaxPlayers: z.number().int().min(2).max(10),
  balancingTolerance: z.number().int().min(0).max(5),
  registeredPlayers: CounterSchema,
  prizePool: ChipAmountSchema,
  startsAt: z.string().datetime().nullable().optional(),
  blindStructure: z.array(
    z.strictObject({
      smallBlind: PositiveChipAmountSchema,
      bigBlind: PositiveChipAmountSchema,
      ante: ChipAmountSchema,
    })
  ),
  payoutPercentages: z.array(z.number().positive()),
  entries: z.array(TournamentEntrySchema),
  tables: z.array(TournamentTableInfoSchema),
  startedAt: z.string().datetime().nullable().optional(),
  finishedAt: z.string().datetime().nullable().optional(),
});
export type TournamentDetailsWire = z.infer<typeof TournamentDetailsSchema>;

export const StartTournamentResponseSchema = z.strictObject({
  success: z.boolean(),
  tableIds: z.array(z.string().min(1)),
  distribution: z.array(CounterSchema),
});
export type StartTournamentResponseWire = z.infer<typeof StartTournamentResponseSchema>;

export const ReconcileTournamentResponseSchema = z.strictObject({
  success: z.boolean(),
  tables: z.array(TournamentTableInfoSchema),
  entries: z.array(TournamentEntrySchema),
});
export type ReconcileTournamentResponseWire = z.infer<typeof ReconcileTournamentResponseSchema>;

export const TournamentPayoutDtoSchema = z.strictObject({
  userId: z.string().min(1),
  placement: CounterSchema,
  amount: ChipAmountSchema,
});
export type TournamentPayoutDtoWire = z.infer<typeof TournamentPayoutDtoSchema>;

export const SettleTournamentResponseSchema = z.strictObject({
  success: z.boolean(),
  winnerUserId: z.string().min(1).optional(),
  prize: ChipAmountSchema.optional(),
  payouts: z.array(TournamentPayoutDtoSchema).optional(),
});
export type SettleTournamentResponseWire = z.infer<typeof SettleTournamentResponseSchema>;
