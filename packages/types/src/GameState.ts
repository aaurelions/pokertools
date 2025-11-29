import { Player } from "./Player";
import { Pot } from "./Pot";
import { TableConfig } from "./Config";
import { ActionRecord } from "./Action";

/**
 * Street in the hand
 */
export const enum Street {
  PREFLOP = "PREFLOP",
  FLOP = "FLOP",
  TURN = "TURN",
  RIVER = "RIVER",
  SHOWDOWN = "SHOWDOWN",
}

/**
 * Winner of a pot
 */
export interface Winner {
  readonly seat: number;
  readonly amount: number;
  readonly hand: readonly string[] | null; // Best 5-card hand or null if uncontested
  readonly handRank: string | null; // Hand description ("Full House, Aces full of Kings")
}

/**
 * Central immutable game state
 */
export interface GameState {
  // Table Configuration
  readonly config: TableConfig;

  // Players (indexed by seat number 0-9, null if empty)
  readonly players: ReadonlyArray<Player | null>;
  readonly maxPlayers: number;

  // Hand State
  readonly handNumber: number;
  readonly buttonSeat: number | null;
  readonly deck: readonly number[]; // Remaining cards (integer codes)
  readonly board: readonly string[]; // Community cards ["As", "Kd", ...]
  readonly street: Street;

  // Betting State
  readonly pots: readonly Pot[]; // Main pot + side pots
  readonly currentBets: ReadonlyMap<number, number>; // Seat -> bet amount this street
  readonly minRaise: number; // Minimum raise size
  readonly lastRaiseAmount: number; // Last raise increment (for incomplete raise rule)
  readonly actionTo: number | null; // Seat number of acting player
  readonly lastAggressorSeat: number | null;

  // Hand Progress
  readonly activePlayers: readonly number[]; // Seats that are not folded/busted
  readonly winners: readonly Winner[] | null;
  readonly rakeThisHand: number; // Total rake collected this hand

  // Blind Tracking
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly blindLevel: number; // Tournament blind level index

  // Time Bank (per-player resource)
  readonly timeBanks: ReadonlyMap<number, number>; // Seat -> seconds remaining

  // History
  readonly actionHistory: readonly ActionRecord[];
  readonly previousStates: readonly GameState[]; // For undo (circular buffer)

  // Metadata
  readonly timestamp: number; // Unix timestamp
  readonly handId: string; // Unique identifier for this hand
}
