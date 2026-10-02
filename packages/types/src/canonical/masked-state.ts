import { z } from "zod";
import {
  ChipAmountSchema,
  CounterSchema,
  EpochMillisSchema,
  HandIdSchema,
  PositiveChipAmountSchema,
} from "./primitives";
import { ActionType } from "../action";
import { Street } from "../game-state";
import { PlayerStatus, SitInOption } from "../player";
import type { PublicPlayer, PublicState } from "../public-state";

/**
 * Canonical PUBLIC wire state.
 *
 * This is the complete, strict, serializable projection of the engine's
 * `PublicState`. It is deliberately a distinct type from the engine interface:
 *
 * - `ReadonlyMap` fields (`currentBets`, `timeBanks`) are plain string-keyed
 *   chip records, exactly as JSON serialization produces them.
 * - `config.randomProvider` is a function and must never be projected.
 * - `previousStates` (undo snapshots containing unmasked hands) is omitted
 *   entirely; a payload carrying it fails strict validation.
 * - `actionHistory` is sanitized to a `PublicActionRecord` so the unmasked
 *   original `Action` payload (internal fields) is never serialized.
 * - Hole cards are only allowed for `viewingPlayerId`, or for an opponent that
 *   the engine legitimately revealed at showdown according to `shownCards`.
 *
 * Required server adapter: {@link toPublicWireState}. Any other projection must
 * reproduce the same mapping; there is no second wire contract.
 */

export const PublicCardSchema = z.string().regex(/^[2-9TJQKA][shdc]$/, "Invalid card");
export type PublicCard = z.infer<typeof PublicCardSchema>;

export const PublicStreetSchema = z.enum(Street);
export type PublicStreet = z.infer<typeof PublicStreetSchema>;

export const PublicPlayerStatusSchema = z.enum(PlayerStatus);
export type PublicPlayerStatus = z.infer<typeof PublicPlayerStatusSchema>;

export const PublicSitInOptionSchema = z.enum(SitInOption);
export type PublicSitInOption = z.infer<typeof PublicSitInOptionSchema>;

export const PublicPotTypeSchema = z.enum(["MAIN", "SIDE"]);
export type PublicPotType = z.infer<typeof PublicPotTypeSchema>;

export const PublicActionTypeSchema = z.enum(ActionType);
export type PublicActionType = z.infer<typeof PublicActionTypeSchema>;

const SeatSchema = z.number().int().min(0).max(9);

export const PublicBlindLevelSchema = z.strictObject({
  smallBlind: PositiveChipAmountSchema,
  bigBlind: PositiveChipAmountSchema,
  ante: ChipAmountSchema,
});
export type PublicBlindLevel = z.infer<typeof PublicBlindLevelSchema>;

/**
 * Serializable table config. `randomProvider` and any non-serializable engine
 * hook are intentionally absent.
 */
export const PublicTableConfigSchema = z.strictObject({
  smallBlind: PositiveChipAmountSchema,
  bigBlind: PositiveChipAmountSchema,
  ante: ChipAmountSchema.optional(),
  maxPlayers: z.number().int().min(2).max(10).optional(),
  initialStack: ChipAmountSchema.optional(),
  blindStructure: z.array(PublicBlindLevelSchema).optional(),
  timeBankSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  timeBankDeductionSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  actionTimeoutSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  allowSpectators: z.boolean().optional(),
  rakePercent: z.number().min(0).max(100).optional(),
  rakeCap: ChipAmountSchema.optional(),
  noFlopNoDrop: z.boolean().optional(),
  validateIntegrity: z.boolean().optional(),
  isClient: z.boolean().optional(),
});
export type PublicTableConfig = z.infer<typeof PublicTableConfigSchema>;

export const PublicPotSchema = z.strictObject({
  amount: ChipAmountSchema,
  eligibleSeats: z.array(SeatSchema),
  type: PublicPotTypeSchema,
  capPerPlayer: ChipAmountSchema,
});
export type PublicPot = z.infer<typeof PublicPotSchema>;

export const PublicWinnerSchema = z.strictObject({
  seat: SeatSchema,
  amount: ChipAmountSchema,
  hand: z.array(PublicCardSchema).nullable(),
  handRank: z.string().nullable(),
});
export type PublicWinner = z.infer<typeof PublicWinnerSchema>;

/**
 * A player projected for a viewer. `hand` may contain `null` placeholders so
 * positional context survives masking.
 */
export const PublicWirePlayerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(50),
  seat: SeatSchema,
  stack: ChipAmountSchema,
  hand: z.array(PublicCardSchema.nullable()).max(2).nullable(),
  shownCards: z.array(z.number().int().min(0).max(1)).max(2).nullable(),
  status: PublicPlayerStatusSchema,
  betThisStreet: ChipAmountSchema,
  totalInvestedThisHand: ChipAmountSchema,
  isSittingOut: z.boolean(),
  timeBank: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pendingAddOn: ChipAmountSchema,
  sitInOption: PublicSitInOptionSchema,
  reservationExpiry: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  pendingStand: z.boolean(),
});
export type PublicWirePlayer = z.infer<typeof PublicWirePlayerSchema>;

/**
 * Sanitized public action-history record: action family + resulting public
 * quantities only. The original `Action` object is never serialized.
 */
export const PublicActionRecordSchema = z.strictObject({
  type: PublicActionTypeSchema,
  seat: SeatSchema.nullable(),
  resultingPot: ChipAmountSchema,
  resultingStack: ChipAmountSchema,
  street: PublicStreetSchema.optional(),
});
export type PublicActionRecord = z.infer<typeof PublicActionRecordSchema>;

/** Plain string-keyed chip record replacing `ReadonlyMap<number, number>`. */
export const SeatChipRecordSchema = z.record(z.string().regex(/^\d+$/), ChipAmountSchema);
export type SeatChipRecord = z.infer<typeof SeatChipRecordSchema>;

function handHasVisibleCards(hand: ReadonlyArray<string | null> | null): boolean {
  return Array.isArray(hand) && hand.some((card) => typeof card === "string" && card.length > 0);
}

export const PublicWireStateSchema = z
  .strictObject({
    config: PublicTableConfigSchema,
    players: z.array(PublicWirePlayerSchema.nullable()).min(2).max(10),
    maxPlayers: z.number().int().min(2).max(10),
    handNumber: CounterSchema,
    buttonSeat: SeatSchema.nullable(),
    bigBlindSeat: SeatSchema.nullable(),
    deck: z.array(z.number().int()),
    board: z.array(PublicCardSchema).max(5),
    street: PublicStreetSchema,
    pots: z.array(PublicPotSchema),
    currentBets: SeatChipRecordSchema,
    minRaise: ChipAmountSchema,
    lastRaiseAmount: ChipAmountSchema,
    actionTo: SeatSchema.nullable(),
    lastAggressorSeat: SeatSchema.nullable(),
    activePlayers: z.array(SeatSchema),
    winners: z.array(PublicWinnerSchema).nullable(),
    rakeThisHand: ChipAmountSchema,
    smallBlind: PositiveChipAmountSchema,
    bigBlind: PositiveChipAmountSchema,
    ante: ChipAmountSchema,
    blindLevel: CounterSchema,
    timeBanks: SeatChipRecordSchema,
    timeBankActiveSeat: SeatSchema.nullable(),
    actionHistory: z.array(PublicActionRecordSchema),
    initialChips: ChipAmountSchema.optional(),
    timestamp: EpochMillisSchema,
    handId: HandIdSchema,
    viewingPlayerId: z.string().min(1).nullable(),
    version: CounterSchema,
  })
  .superRefine((state, ctx) => {
    if (state.deck.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["deck"], message: "deck must be masked (empty)" });
    }
    if (state.players.length !== state.maxPlayers) {
      ctx.addIssue({
        code: "custom",
        path: ["players"],
        message: "players length must equal maxPlayers",
      });
    }

    const viewerId = state.viewingPlayerId;
    const seenCards = new Set<string>();

    for (let i = 0; i < state.players.length; i++) {
      const player = state.players[i];
      if (player === null) continue;

      if (player.seat !== i) {
        ctx.addIssue({
          code: "custom",
          path: ["players", i, "seat"],
          message: "player seat must equal its array index",
        });
      }

      const isViewer = viewerId !== null && player.id === viewerId;
      if (isViewer) {
        if (state.street === "SHOWDOWN" || handHasVisibleCards(player.hand)) {
          if (Array.isArray(player.hand)) {
            for (const card of player.hand) {
              if (typeof card === "string" && card.length > 0) seenCards.add(card);
            }
          }
        }
        continue;
      }

      // Non-viewer: the only legitimate reveal is a showdown show.
      const shown = player.shownCards;
      const revealedOpponent = shown !== null && shown.length > 0;
      if (revealedOpponent) {
        if (state.street !== "SHOWDOWN") {
          ctx.addIssue({
            code: "custom",
            path: ["players", i, "shownCards"],
            message: "opponent cards cannot be revealed before showdown",
          });
        }
        if (player.status !== "ACTIVE" && player.status !== "ALL_IN") {
          ctx.addIssue({
            code: "custom",
            path: ["players", i, "shownCards"],
            message: "only active/all-in players may reveal at showdown",
          });
        }
        if (!Array.isArray(player.hand)) {
          ctx.addIssue({
            code: "custom",
            path: ["players", i, "hand"],
            message: "a revealed opponent must expose a positional hand array",
          });
        } else {
          for (let c = 0; c < player.hand.length; c++) {
            const card = player.hand[c];
            if (card === null || card === undefined) continue;
            if (!shown.includes(c)) {
              ctx.addIssue({
                code: "custom",
                path: ["players", i, "hand", c],
                message: "card visible at an index not listed in shownCards",
              });
            }
            seenCards.add(card);
          }
        }
      } else if (handHasVisibleCards(player.hand)) {
        ctx.addIssue({
          code: "custom",
          path: ["players", i, "hand"],
          message: "opponent hole cards must be masked",
        });
      }
    }

    if (viewerId !== null) {
      const viewerPresent = state.players.some((player) => player?.id === viewerId);
      if (!viewerPresent) {
        ctx.addIssue({
          code: "custom",
          path: ["viewingPlayerId"],
          message: "viewingPlayerId must reference a seated player",
        });
      }
    }
  });
export type PublicWireState = z.infer<typeof PublicWireStateSchema>;

/** @deprecated Use {@link PublicWireStateSchema}. Retained as an alias. */
export const MaskedPublicStateSchema = PublicWireStateSchema;
/** @deprecated use {@link PublicWireState}. */
export type MaskedPublicState = PublicWireState;

// ============================================================================
// Server adapter (exact mapping engine PublicState -> canonical wire state)
// ============================================================================

/** Project an engine table config to its serializable wire form. */
export function toPublicTableConfig(config: PublicState["config"]): PublicTableConfig {
  return {
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    ...(config.ante !== undefined && { ante: config.ante }),
    ...(config.maxPlayers !== undefined && { maxPlayers: config.maxPlayers }),
    ...(config.initialStack !== undefined && { initialStack: config.initialStack }),
    ...(config.blindStructure !== undefined && {
      blindStructure: config.blindStructure.map((level) => ({
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
        ante: level.ante,
      })),
    }),
    ...(config.timeBankSeconds !== undefined && { timeBankSeconds: config.timeBankSeconds }),
    ...(config.timeBankDeductionSeconds !== undefined && {
      timeBankDeductionSeconds: config.timeBankDeductionSeconds,
    }),
    ...(config.actionTimeoutSeconds !== undefined && {
      actionTimeoutSeconds: config.actionTimeoutSeconds,
    }),
    ...(config.allowSpectators !== undefined && { allowSpectators: config.allowSpectators }),
    ...(config.rakePercent !== undefined && { rakePercent: config.rakePercent }),
    ...(config.rakeCap !== undefined && { rakeCap: config.rakeCap }),
    ...(config.noFlopNoDrop !== undefined && { noFlopNoDrop: config.noFlopNoDrop }),
    ...(config.validateIntegrity !== undefined && { validateIntegrity: config.validateIntegrity }),
    ...(config.isClient !== undefined && { isClient: config.isClient }),
  };
}

/** Project a masked engine player to the wire player shape. */
export function toPublicWirePlayer(player: PublicPlayer): PublicWirePlayer {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    stack: player.stack,
    hand: player.hand === null ? null : [...player.hand],
    shownCards: player.shownCards === null ? null : [...player.shownCards],
    status: player.status,
    betThisStreet: player.betThisStreet,
    totalInvestedThisHand: player.totalInvestedThisHand,
    isSittingOut: player.isSittingOut,
    timeBank: player.timeBank,
    pendingAddOn: player.pendingAddOn,
    sitInOption: player.sitInOption,
    reservationExpiry: player.reservationExpiry,
    pendingStand: player.pendingStand,
  };
}

function mapToChipRecord(source: ReadonlyMap<number, number>): SeatChipRecord {
  const record: SeatChipRecord = {};
  for (const [seat, amount] of source.entries()) {
    record[String(seat)] = amount;
  }
  return record;
}

/**
 * Exact server-side adapter from the engine's masked `PublicState` to the
 * canonical public wire state. Serializes Maps to records, drops
 * `previousStates`, drops `config.randomProvider`, and sanitizes action history.
 */
export function toPublicWireState(state: PublicState): PublicWireState {
  return {
    config: toPublicTableConfig(state.config),
    players: state.players.map((player) => (player === null ? null : toPublicWirePlayer(player))),
    maxPlayers: state.maxPlayers,
    handNumber: state.handNumber,
    buttonSeat: state.buttonSeat,
    bigBlindSeat: state.bigBlindSeat,
    deck: [...state.deck],
    board: [...state.board],
    street: state.street,
    pots: state.pots.map((pot) => ({
      amount: pot.amount,
      eligibleSeats: [...pot.eligibleSeats],
      type: pot.type,
      capPerPlayer: pot.capPerPlayer,
    })),
    currentBets: mapToChipRecord(state.currentBets),
    minRaise: state.minRaise,
    lastRaiseAmount: state.lastRaiseAmount,
    actionTo: state.actionTo,
    lastAggressorSeat: state.lastAggressorSeat,
    activePlayers: [...state.activePlayers],
    winners:
      state.winners === null
        ? null
        : state.winners.map((winner) => ({
            seat: winner.seat,
            amount: winner.amount,
            hand: winner.hand === null ? null : [...winner.hand],
            handRank: winner.handRank,
          })),
    rakeThisHand: state.rakeThisHand,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    ante: state.ante,
    blindLevel: state.blindLevel,
    timeBanks: mapToChipRecord(state.timeBanks),
    timeBankActiveSeat: state.timeBankActiveSeat,
    actionHistory: state.actionHistory.map((record) => ({
      type: record.action.type,
      seat: record.seat,
      resultingPot: record.resultingPot,
      resultingStack: record.resultingStack,
      ...(record.street !== undefined && { street: record.street as PublicStreet }),
    })),
    ...(state.initialChips !== undefined && { initialChips: state.initialChips }),
    timestamp: state.timestamp,
    handId: state.handId,
    viewingPlayerId: state.players.some((player) => player?.id === state.viewingPlayerId)
      ? state.viewingPlayerId
      : null,
    version: state.version,
  };
}

/**
 * Serialize a canonical public wire state to JSON. Map fields are already plain
 * records, so no custom replacer is required.
 */
export function serializePublicWireState(state: PublicWireState): string {
  return JSON.stringify(state);
}

/** Parse and strictly validate a canonical public wire state from JSON. */
export function parsePublicWireState(json: string): PublicWireState {
  return PublicWireStateSchema.parse(JSON.parse(json));
}
