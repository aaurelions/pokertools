import {
  GameState,
  TimeoutAction,
  TimeBankAction,
  PlayerStatus,
  ActionType,
} from "@pokertools/types";
import { getPlayerById } from "../utils/positioning";
import { getNextToAct } from "../rules/actionOrder";

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

  // Determine if player needs to call
  const currentBet = getCurrentBet(state);
  const playerBet = state.currentBets.get(seat) ?? 0;
  const needsToCall = currentBet > playerBet;

  const newPlayers = [...state.players];

  if (needsToCall) {
    // Player must fold
    newPlayers[seat] = {
      ...player,
      status: PlayerStatus.FOLDED,
      isSittingOut: true,
    };
  } else {
    // Player can check, but mark as sitting out
    newPlayers[seat] = {
      ...player,
      isSittingOut: true,
    };
  }

  const newActivePlayers = needsToCall
    ? state.activePlayers.filter((s) => s !== seat)
    : state.activePlayers;

  const newState: GameState = {
    ...state,
    players: newPlayers,
    activePlayers: newActivePlayers,
    timestamp: action.timestamp!,
  };

  // Move to next player
  const nextToAct = getNextToAct(newState);

  return {
    ...newState,
    actionTo: nextToAct,
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
  const deduction = state.config.timeBankDeductionSeconds ?? 10;
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
