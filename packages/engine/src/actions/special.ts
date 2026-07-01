import {
  GameState,
  TimeoutAction,
  TimeBankAction,
  PlayerStatus,
  ActionType,
} from "@pokertools/types";
import { getPlayerById } from "../utils/positioning";
import { getNextToAct } from "../rules/action-order";

const DEFAULT_TIME_BANK_DEDUCTION_SECONDS = 10;

function getTotalPot(state: GameState): number {
  let total = 0;
  for (const pot of state.pots) total += pot.amount;
  for (const bet of state.currentBets.values()) total += bet;
  return total;
}

/**
 * Handle TIMEOUT action
 * - Folds player if they have bet to call
 * - Checks if allowed, otherwise folds
 * - Marks player as sitting out
 */
export function handleTimeout(state: GameState, action: TimeoutAction): GameState {
  const result = getPlayerById(state, action.playerId);

  if (!result) {
    return state;
  }

  const { player, seat } = result;

  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;
  const needsToCall = currentBet > playerBet;

  const newPlayers = [...state.players];

  if (needsToCall) {
    newPlayers[seat] = {
      ...player,
      status: PlayerStatus.FOLDED,
      isSittingOut: true,
    };
  } else {
    newPlayers[seat] = {
      ...player,
      isSittingOut: true,
    };
  }

  const newActivePlayers = needsToCall
    ? state.activePlayers.filter((s) => s !== seat)
    : state.activePlayers;

  const actionRecord = {
    action,
    seat,
    resultingPot: getTotalPot(state),
    resultingStack: newPlayers[seat]?.stack ?? 0,
    street: state.street,
  };

  const newState: GameState = {
    ...state,
    players: newPlayers,
    activePlayers: newActivePlayers,
    actionHistory: [...state.actionHistory, actionRecord],
    timestamp: action.timestamp!,
  };

  const nextToAct = getNextToAct(newState);
  const actionableNext =
    nextToAct !== null && !newPlayers[nextToAct]?.isSittingOut ? nextToAct : null;

  return {
    ...newState,
    actionTo: actionableNext === seat ? null : actionableNext,
  };
}

/**
 * Handle TIME_BANK action
 * - Deducts time from player's time bank
 * - Keeps action on same player
 *
 * TIME BANK DEDUCTION POLICY:
 * This implementation uses a "pay-per-activation" model where:
 * - Each time bank activation deducts a fixed amount (default: 10 seconds)
 * - Player receives the full deduction amount as additional time
 * - If remaining time bank is less than the deduction, it is fully consumed
 * - This prevents players from getting "free" time when they have < 10s remaining
 *
 * Example scenarios:
 * - Player has 30s, activates time bank → 20s remaining, gets 10s additional time
 * - Player has 5s, activates time bank → 0s remaining, gets 10s additional time
 * - Player has 0s, cannot activate time bank → forced timeout/fold
 *
 * Alternative design consideration:
 * If you want "time-as-resource" (only deduct what you use), you would need:
 * - Track time used per activation in the UI layer
 * - Deduct actual time consumed rather than fixed amount
 * - Return unused time if action is made before deduction expires
 */
export function handleTimeBank(state: GameState, action: TimeBankAction): GameState {
  const result = getPlayerById(state, action.playerId);

  if (!result) {
    return state;
  }

  const { seat } = result;

  const currentTimeBank = state.timeBanks.get(seat) ?? 0;

  if (currentTimeBank <= 0) {
    // No time bank left, force timeout
    return handleTimeout(state, {
      type: ActionType.TIMEOUT,
      playerId: action.playerId,
      timestamp: action.timestamp,
    });
  }

  // Deduct time from player's time bank (configurable, default 10 seconds)
  // Uses pay-per-activation model: deduct full amount even if less is available
  const deduction = state.config.timeBankDeductionSeconds ?? DEFAULT_TIME_BANK_DEDUCTION_SECONDS;
  const newTimeBank = Math.max(0, currentTimeBank - deduction);

  const newTimeBanks = new Map(state.timeBanks);
  newTimeBanks.set(seat, newTimeBank);

  return {
    ...state,
    timeBanks: newTimeBanks,
    timeBankActiveSeat: seat, // Mark time bank as active for this player
    timestamp: action.timestamp!,
    // Keep actionTo the same (extends player's turn)
  };
}

/**
 * Get current highest bet
 */
function getCurrentBet(state: GameState): number {
  let maxBet = 0;
  for (const bet of state.currentBets.values()) {
    if (bet > maxBet) {
      maxBet = bet;
    }
  }
  return maxBet;
}
