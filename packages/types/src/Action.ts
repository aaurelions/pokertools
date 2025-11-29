/**
 * Action types that can be performed in the game
 */
export const enum ActionType {
  // Management
  SIT = "SIT",
  STAND = "STAND",

  // Dealing
  DEAL = "DEAL",

  // Betting
  FOLD = "FOLD",
  CHECK = "CHECK",
  CALL = "CALL",
  BET = "BET",
  RAISE = "RAISE",

  // Showdown
  SHOW = "SHOW",
  MUCK = "MUCK",

  // Special
  TIMEOUT = "TIMEOUT",
  TIME_BANK = "TIME_BANK",
  UNCALLED_BET_RETURNED = "UNCALLED_BET_RETURNED",

  // Tournament
  NEXT_BLIND_LEVEL = "NEXT_BLIND_LEVEL",
}

/**
 * Base interface for all actions
 */
export interface BaseAction {
  readonly type: ActionType;
  readonly timestamp?: number;
}

/**
 * Sit at table
 */
export interface SitAction extends BaseAction {
  readonly type: ActionType.SIT;
  readonly playerId: string;
  readonly playerName: string;
  readonly seat: number;
  readonly stack: number;
}

/**
 * Stand from table
 */
export interface StandAction extends BaseAction {
  readonly type: ActionType.STAND;
  readonly playerId: string;
}

/**
 * Deal new hand
 */
export interface DealAction extends BaseAction {
  readonly type: ActionType.DEAL;
}

/**
 * Fold hand
 */
export interface FoldAction extends BaseAction {
  readonly type: ActionType.FOLD;
  readonly playerId: string;
}

/**
 * Check (no bet to call)
 */
export interface CheckAction extends BaseAction {
  readonly type: ActionType.CHECK;
  readonly playerId: string;
}

/**
 * Call current bet
 */
export interface CallAction extends BaseAction {
  readonly type: ActionType.CALL;
  readonly playerId: string;
}

/**
 * Bet (opening bet)
 */
export interface BetAction extends BaseAction {
  readonly type: ActionType.BET;
  readonly playerId: string;
  readonly amount: number; // Total bet size
}

/**
 * Raise existing bet
 */
export interface RaiseAction extends BaseAction {
  readonly type: ActionType.RAISE;
  readonly playerId: string;
  readonly amount: number; // Total raise amount
}

/**
 * Show cards at showdown
 */
export interface ShowAction extends BaseAction {
  readonly type: ActionType.SHOW;
  readonly playerId: string;
  readonly cardIndices?: readonly number[]; // Indices to show [0, 1] for both, [0] for first, etc. Default: all cards
}

/**
 * Muck cards at showdown (hide cards)
 */
export interface MuckAction extends BaseAction {
  readonly type: ActionType.MUCK;
  readonly playerId: string;
}

/**
 * Player timeout
 */
export interface TimeoutAction extends BaseAction {
  readonly type: ActionType.TIMEOUT;
  readonly playerId: string;
}

/**
 * Activate time bank
 */
export interface TimeBankAction extends BaseAction {
  readonly type: ActionType.TIME_BANK;
  readonly playerId: string;
}

/**
 * Uncalled bet returned to player
 */
export interface UncalledBetReturnedAction extends BaseAction {
  readonly type: ActionType.UNCALLED_BET_RETURNED;
  readonly playerId: string;
  readonly amount: number;
}

/**
 * Advance blind level (tournament)
 */
export interface NextBlindLevelAction extends BaseAction {
  readonly type: ActionType.NEXT_BLIND_LEVEL;
}

/**
 * Union type of all possible actions
 */
export type Action =
  | SitAction
  | StandAction
  | DealAction
  | FoldAction
  | CheckAction
  | CallAction
  | BetAction
  | RaiseAction
  | ShowAction
  | MuckAction
  | TimeoutAction
  | TimeBankAction
  | UncalledBetReturnedAction
  | NextBlindLevelAction;

/**
 * Action record for history tracking
 */
export interface ActionRecord {
  readonly action: Action;
  readonly seat: number | null; // null for table-level actions
  readonly resultingPot: number;
  readonly resultingStack: number;
  readonly street?: string; // Street when action occurred
}
