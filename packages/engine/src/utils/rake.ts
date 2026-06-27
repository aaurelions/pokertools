import { GameState } from "@pokertools/types";

/**
 * Calculate rake for a pot amount, respecting global per-hand rake cap
 *
 * @param state Current game state
 * @param potAmount Amount in the pot to calculate rake from
 * @param rakeTakenSoFar Total rake already taken this hand (for cap enforcement)
 * @returns Object with rake amount and whether cap was hit
 */
export function calculateRake(
  state: GameState,
  potAmount: number,
  rakeTakenSoFar = 0
): { rake: number; capReached: boolean } {
  // No rake for tournaments (identified by presence of blindStructure)
  if (state.config.blindStructure) {
    return { rake: 0, capReached: false };
  }

  const rakePercent = state.config.rakePercent ?? 0;
  if (rakePercent === 0) {
    return { rake: 0, capReached: false };
  }

  // "No Flop, No Drop" rule (standard in most cash games).
  // When enabled (default), no rake is taken if no flop was dealt,
  // regardless of whether the hand ended preflop or all-in preflop.
  const noFlopNoDrop = state.config.noFlopNoDrop !== false;
  if (noFlopNoDrop && state.board.length === 0) {
    return { rake: 0, capReached: false };
  }

  let rake = Math.floor((potAmount * rakePercent) / 100);

  // Apply per-hand rake cap (not per-pot).
  let capReached = false;
  if (state.config.rakeCap !== undefined) {
    const rakeAllowed = state.config.rakeCap - rakeTakenSoFar;
    if (rakeAllowed <= 0) {
      // Cap already reached
      return { rake: 0, capReached: true };
    }
    if (rake > rakeAllowed) {
      rake = rakeAllowed;
      capReached = true;
    }
  }

  return { rake, capReached };
}
