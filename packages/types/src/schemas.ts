import { z } from "zod";

/**
 * Shared Zod validation schemas for type-safe, client-side validation
 *
 * These schemas can be used by:
 * - API endpoints for request validation
 * - Engine for action validation
 * - Client SDK for pre-flight validation (avoiding unnecessary network requests)
 */

// ============================================================================
// Action Schemas
// ============================================================================

/**
 * Schema for SIT action (joining a table)
 */
export const SitActionSchema = z.object({
  type: z.literal("SIT"),
  playerId: z.string().min(1, "Player ID is required"),
  playerName: z.string().min(1, "Player name is required").max(50, "Name too long"),
  seat: z.number().int().min(0).max(9, "Seat must be between 0 and 9"),
  stack: z.number().int().positive("Stack must be positive"),
  sitInOption: z.enum(["IMMEDIATE", "WAIT_FOR_BB"]).optional(),
});

/**
 * Schema for STAND action (leaving a table)
 */
export const StandActionSchema = z.object({
  type: z.literal("STAND"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for BET action
 */
export const BetActionSchema = z.object({
  type: z.literal("BET"),
  playerId: z.string().min(1, "Player ID is required"),
  amount: z.number().int().positive("Bet amount must be positive"),
});

/**
 * Schema for RAISE action
 */
export const RaiseActionSchema = z.object({
  type: z.literal("RAISE"),
  playerId: z.string().min(1, "Player ID is required"),
  amount: z.number().int().positive("Raise amount must be positive"),
});

/**
 * Schema for CALL action
 */
export const CallActionSchema = z.object({
  type: z.literal("CALL"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for CHECK action
 */
export const CheckActionSchema = z.object({
  type: z.literal("CHECK"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for FOLD action
 */
export const FoldActionSchema = z.object({
  type: z.literal("FOLD"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for DEAL action
 */
export const DealActionSchema = z.object({
  type: z.literal("DEAL"),
});

/**
 * Schema for ADD_CHIPS action
 */
export const AddChipsActionSchema = z.object({
  type: z.literal("ADD_CHIPS"),
  playerId: z.string().min(1, "Player ID is required"),
  amount: z.number().int().positive("Amount must be positive"),
});

/**
 * Schema for RESERVE_SEAT action
 */
export const ReserveSeatActionSchema = z.object({
  type: z.literal("RESERVE_SEAT"),
  playerId: z.string().min(1, "Player ID is required"),
  playerName: z.string().min(1, "Player name is required").max(50, "Name too long"),
  seat: z.number().int().min(0).max(9, "Seat must be between 0 and 9"),
  expiryTimestamp: z.number().int().positive("Expiry timestamp must be positive"),
});

/**
 * Schema for SHOW action (showing cards at showdown)
 */
export const ShowActionSchema = z.object({
  type: z.literal("SHOW"),
  playerId: z.string().min(1, "Player ID is required"),
  cardIndices: z.array(z.number().int().min(0).max(1)).optional(),
});

/**
 * Schema for MUCK action (hiding cards at showdown)
 */
export const MuckActionSchema = z.object({
  type: z.literal("MUCK"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for TIME_BANK action
 */
export const TimeBankActionSchema = z.object({
  type: z.literal("TIME_BANK"),
  playerId: z.string().min(1, "Player ID is required"),
});

/**
 * Schema for TIMEOUT action
 */
export const TimeoutActionSchema = z.object({
  type: z.literal("TIMEOUT"),
  playerId: z.string().min(1, "Player ID is required"),
  timestamp: z.number().int().positive("Timestamp must be positive").optional(),
});

/**
 * Schema for NEXT_BLIND_LEVEL action (tournament)
 */
export const NextBlindLevelActionSchema = z.object({
  type: z.literal("NEXT_BLIND_LEVEL"),
});

/**
 * Schema for UNCALLED_BET_RETURNED action (internal engine action)
 * Generated when an uncalled bet is returned to a player
 */
export const UncalledBetReturnedActionSchema = z.object({
  type: z.literal("UNCALLED_BET_RETURNED"),
  playerId: z.string().min(1, "Player ID is required"),
  amount: z.number().int().positive("Amount must be positive"),
});

/**
 * Union of all action schemas
 */
export const ActionSchema = z.discriminatedUnion("type", [
  SitActionSchema,
  StandActionSchema,
  BetActionSchema,
  RaiseActionSchema,
  CallActionSchema,
  CheckActionSchema,
  FoldActionSchema,
  DealActionSchema,
  AddChipsActionSchema,
  ReserveSeatActionSchema,
  ShowActionSchema,
  MuckActionSchema,
  TimeBankActionSchema,
  TimeoutActionSchema,
  NextBlindLevelActionSchema,
  UncalledBetReturnedActionSchema,
]);

// ============================================================================
// Table Configuration Schemas
// ============================================================================

/**
 * Persisted configuration amounts are 32-bit columns (buy-in, fee, starting
 * stack, blinds, min/max buy-in). Creation inputs are bounded to this so a
 * valid configuration can never overflow its column. Aggregated chip amounts
 * (pots, prize pools, winning stacks) are NOT bounded by this and may exceed
 * 32 bits; they are held as BigInt internally and converted exactly at the
 * public wire boundary.
 */
export const MAX_INT32_CHIP_CONFIG = 2_147_483_647;

/**
 * Schema for blind level configuration
 */
export const BlindLevelSchema = z.object({
  smallBlind: z
    .number()
    .int()
    .positive("Small blind must be positive")
    .max(MAX_INT32_CHIP_CONFIG, "Small blind exceeds the 32-bit configuration range"),
  bigBlind: z
    .number()
    .int()
    .positive("Big blind must be positive")
    .max(MAX_INT32_CHIP_CONFIG, "Big blind exceeds the 32-bit configuration range"),
  ante: z
    .number()
    .int()
    .min(0, "Ante cannot be negative")
    .max(MAX_INT32_CHIP_CONFIG, "Ante exceeds the 32-bit configuration range"),
});

/**
 * Schema for table configuration
 */
export const TableConfigSchema = z
  .object({
    smallBlind: z
      .number()
      .int()
      .positive("Small blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Small blind exceeds the 32-bit configuration range"),
    bigBlind: z
      .number()
      .int()
      .positive("Big blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Big blind exceeds the 32-bit configuration range"),
    ante: z
      .number()
      .int()
      .min(0, "Ante cannot be negative")
      .max(MAX_INT32_CHIP_CONFIG, "Ante exceeds the 32-bit configuration range")
      .optional(),
    maxPlayers: z
      .number()
      .int()
      .min(2, "Must have at least 2 players")
      .max(10, "Maximum 10 players"),
    blindStructure: z.array(BlindLevelSchema).optional(),
    rakePercent: z.number().min(0).max(100).optional(),
    rakeCap: z.number().int().min(0).max(MAX_INT32_CHIP_CONFIG).optional(),
    timeBankSeconds: z.number().int().positive().optional(),
    timeBankDeductionSeconds: z.number().int().positive().optional(),
  })
  .refine((config) => config.bigBlind > config.smallBlind, {
    message: "Big blind must be greater than small blind",
    path: ["bigBlind"],
  });

/**
 * Schema for creating a new table
 */
export const CreateTableSchema = z
  .object({
    name: z.string().min(1, "Table name is required").max(100, "Name too long"),
    mode: z.enum(["CASH", "TOURNAMENT"]),
    smallBlind: z
      .number()
      .int()
      .positive("Small blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Small blind exceeds the 32-bit configuration range"),
    bigBlind: z
      .number()
      .int()
      .positive("Big blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Big blind exceeds the 32-bit configuration range"),
    maxPlayers: z.number().int().min(2).max(10).default(9),
    minBuyIn: z
      .number()
      .int()
      .positive()
      .max(MAX_INT32_CHIP_CONFIG, "Minimum buy-in exceeds the 32-bit configuration range")
      .optional(),
    maxBuyIn: z
      .number()
      .int()
      .positive()
      .max(MAX_INT32_CHIP_CONFIG, "Maximum buy-in exceeds the 32-bit configuration range")
      .optional(),
    ante: z
      .number()
      .int()
      .min(0)
      .max(MAX_INT32_CHIP_CONFIG, "Ante exceeds the 32-bit configuration range")
      .optional(),
    rakePercent: z.number().min(0).max(100).optional(),
    rakeCap: z.number().int().min(0).max(MAX_INT32_CHIP_CONFIG).optional(),
    noFlopNoDrop: z.boolean().optional(),
    timeBankSeconds: z.number().int().positive().optional(),
    timeBankDeductionSeconds: z.number().int().positive().optional(),
    actionTimeoutSeconds: z.number().int().positive().optional(),
    allowSpectators: z.boolean().optional(),
  })
  .refine((config) => config.bigBlind > config.smallBlind, {
    message: "Big blind must be greater than small blind",
    path: ["bigBlind"],
  })
  .refine(
    (config) => {
      if (config.minBuyIn !== undefined && config.maxBuyIn !== undefined) {
        return config.maxBuyIn >= config.minBuyIn;
      }
      return true;
    },
    {
      message: "Max buy-in must be greater than or equal to min buy-in",
      path: ["maxBuyIn"],
    }
  );

export const TournamentPayoutSchema = z
  .array(z.number().positive("Payout percentage must be positive"))
  .min(1, "At least one payout percentage is required")
  .refine((percentages) => percentages.reduce((sum, percentage) => sum + percentage, 0) === 100, {
    message: "Tournament payout percentages must total 100",
  });

export const CreateTournamentSchema = z
  .object({
    name: z.string().min(1, "Tournament name is required").max(100, "Name too long"),
    buyIn: z
      .number()
      .int()
      .positive("Buy-in must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Buy-in exceeds the 32-bit configuration range"),
    fee: z
      .number()
      .int()
      .min(0, "Fee cannot be negative")
      .max(MAX_INT32_CHIP_CONFIG, "Fee exceeds the 32-bit configuration range")
      .default(0),
    startingStack: z
      .number()
      .int()
      .positive("Starting stack must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Starting stack exceeds the 32-bit configuration range"),
    smallBlind: z
      .number()
      .int()
      .positive("Small blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Small blind exceeds the 32-bit configuration range"),
    bigBlind: z
      .number()
      .int()
      .positive("Big blind must be positive")
      .max(MAX_INT32_CHIP_CONFIG, "Big blind exceeds the 32-bit configuration range"),
    maxPlayers: z
      .number()
      .int()
      .min(2, "Must have at least 2 players")
      .max(100, "Maximum 100 players total")
      .default(9),
    tableMaxPlayers: z
      .number()
      .int()
      .min(2, "Must have at least 2 players per table")
      .max(10, "Maximum 10 players per table")
      .default(10),
    balancingTolerance: z
      .number()
      .int()
      .min(0, "Balancing tolerance cannot be negative")
      .max(5, "Maximum balancing tolerance is 5")
      .default(2),
    startsAt: z.string().datetime().optional(),
    blindStructure: z.array(BlindLevelSchema).optional(),
    payoutPercentages: TournamentPayoutSchema.default([100]),
  })
  .refine((config) => config.bigBlind > config.smallBlind, {
    message: "Big blind must be greater than small blind",
    path: ["bigBlind"],
  })
  .refine(
    (config) => {
      // Validate blind structure is strictly increasing if provided
      const levels = config.blindStructure;
      if (!levels || levels.length <= 1) return true;
      for (let i = 1; i < levels.length; i++) {
        const prev = levels[i - 1];
        const curr = levels[i];
        if (curr.smallBlind <= prev.smallBlind) return false;
        if (curr.bigBlind <= prev.bigBlind) return false;
      }
      return true;
    },
    {
      message: "Blind structure levels must be strictly increasing",
      path: ["blindStructure"],
    }
  );

export const RegisterTournamentRequestSchema = z.object({
  seat: z.number().int().min(0, "Seat must be at least 0"),
  idempotencyKey: z.string().min(1, "Idempotency key is required"),
});

// ============================================================================
// API Request Schemas
// ============================================================================

/**
 * Schema for buy-in request
 */
export const BuyInRequestSchema = z.object({
  amount: z.number().int().positive("Buy-in amount must be positive"),
  seat: z.number().int().min(0).max(9, "Seat must be between 0 and 9"),
  idempotencyKey: z.string().min(1, "Idempotency key is required"),
  sitInOption: z.enum(["IMMEDIATE", "WAIT_FOR_BB"]).optional(),
});

/**
 * Schema for add chips request
 */
export const AddChipsRequestSchema = z.object({
  amount: z.number().int().positive("Amount must be positive"),
  idempotencyKey: z.string().min(1, "Idempotency key is required"),
});

// ============================================================================
// Type Inference Helpers
// ============================================================================

// Action types are defined in action.ts; here we only export the
// Zod-inferred union type to avoid duplicate type declarations.

export type ValidatedAction = z.infer<typeof ActionSchema>;
export type ValidatedBlindLevel = z.infer<typeof BlindLevelSchema>;
export type ValidatedTableConfig = z.infer<typeof TableConfigSchema>;
export type CreateTableRequest = z.infer<typeof CreateTableSchema>;
export type CreateTournamentRequest = z.infer<typeof CreateTournamentSchema>;
export type RegisterTournamentRequest = z.infer<typeof RegisterTournamentRequestSchema>;
export type BuyInRequest = z.infer<typeof BuyInRequestSchema>;
export type AddChipsRequest = z.infer<typeof AddChipsRequestSchema>;
