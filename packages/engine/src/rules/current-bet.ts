import { GameState, Street } from "@pokertools/types";

/**
 * Return the price players must match on the current street.
 *
 * A short all-in big blind does not reduce the nominal preflop bring-in for
 * players who still have chips. Actual contributions remain unchanged so the
 * unmatched portion can be returned and side pots can be formed normally.
 */
export function getCurrentBet(state: GameState): number {
  let currentBet = 0;
  for (const bet of state.currentBets.values()) {
    currentBet = Math.max(currentBet, bet);
  }

  return state.street === Street.PREFLOP ? Math.max(currentBet, state.bigBlind) : currentBet;
}
