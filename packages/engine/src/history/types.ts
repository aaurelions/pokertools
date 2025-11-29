/**
 * Hand history types
 */

import { Street, Action } from "@pokertools/types";

/**
 * Hand history record
 * Contains complete information about a single hand
 */
export interface HandHistory {
  readonly handId: string;
  readonly timestamp: number;
  readonly tableName: string;
  readonly gameType: "Cash" | "Tournament";
  readonly stakes: {
    readonly smallBlind: number;
    readonly bigBlind: number;
    readonly ante: number;
  };
  readonly maxPlayers: number;
  readonly buttonSeat: number;
  readonly players: readonly HandHistoryPlayer[];
  readonly streets: readonly StreetHistory[];
  readonly winners: readonly WinnerRecord[];
  readonly totalPot: number;
}

/**
 * Player information in hand history
 */
export interface HandHistoryPlayer {
  readonly seat: number;
  readonly name: string;
  readonly startingStack: number;
  readonly endingStack: number;
  readonly cards?: readonly string[]; // Hole cards (if shown)
}

/**
 * History for a single street
 */
export interface StreetHistory {
  readonly street: Street;
  readonly board: readonly string[];
  readonly actions: readonly ActionRecord[];
  readonly pot: number;
}

/**
 * Action record in history
 */
export interface ActionRecord {
  readonly seat: number;
  readonly playerName: string;
  readonly action: Action;
  readonly amount?: number;
  readonly isAllIn?: boolean;
  readonly timestamp: number;
}

/**
 * Winner record
 */
export interface WinnerRecord {
  readonly seat: number;
  readonly playerName: string;
  readonly amount: number;
  readonly hand?: readonly string[];
  readonly handRank?: string;
}

/**
 * Hand history format options
 */
export interface ExportOptions {
  readonly format: "pokerstars" | "json" | "compact";
  readonly includeHoleCards?: boolean; // Include all hole cards (for analysis)
  readonly timezone?: string; // For timestamp formatting
}
