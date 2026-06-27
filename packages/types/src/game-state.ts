import { Player } from "./player";
import { Pot } from "./pot";
import { TableConfig } from "./config";
import { ActionRecord } from "./action";

/** Street in the hand. */
export const enum Street {
  PREFLOP = "PREFLOP",
  FLOP = "FLOP",
  TURN = "TURN",
  RIVER = "RIVER",
  SHOWDOWN = "SHOWDOWN",
}

/** Winner of a pot. */
export interface Winner {
  readonly seat: number;
  readonly amount: number;
  /** Best 5-card hand, or null if uncontested. */
  readonly hand: readonly string[] | null;
  /** Hand description, e.g. "Full House, Aces full of Kings". */
  readonly handRank: string | null;
}

/** Central immutable game state. */
export interface GameState {
  readonly config: TableConfig;

  /** Players indexed by seat 0-9; null = empty seat. */
  readonly players: ReadonlyArray<Player | null>;
  readonly maxPlayers: number;

  readonly handNumber: number;
  readonly buttonSeat: number | null;
  /** Remaining cards as integer codes. */
  readonly deck: readonly number[];
  /** Community cards, e.g. ["As", "Kd", ...]. */
  readonly board: readonly string[];
  readonly street: Street;

  /** Main pot + side pots. */
  readonly pots: readonly Pot[];
  /** Seat → amount bet this street. */
  readonly currentBets: ReadonlyMap<number, number>;
  readonly minRaise: number;
  /** Last raise increment (for the incomplete-raise rule). */
  readonly lastRaiseAmount: number;
  /** Seat of the acting player, or null when no action pending. */
  readonly actionTo: number | null;
  readonly lastAggressorSeat: number | null;

  /** Seats not folded or busted. */
  readonly activePlayers: readonly number[];
  readonly winners: readonly Winner[] | null;
  readonly rakeThisHand: number;

  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  /** Index into the tournament blind schedule. */
  readonly blindLevel: number;

  /** Seat → time bank seconds remaining. */
  readonly timeBanks: ReadonlyMap<number, number>;
  /** Seat currently using time bank (null if none active). */
  readonly timeBankActiveSeat: number | null;

  readonly actionHistory: readonly ActionRecord[];
  /** Previous states for undo (circular buffer). */
  readonly previousStates: readonly GameState[];

  /** Baseline chip count for conservation checks during a hand. */
  readonly initialChips?: number;
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
  /** Unique identifier for this hand. */
  readonly handId: string;
}
